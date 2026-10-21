import { Injectable, Logger } from '@nestjs/common';
import { OAuthClientSource, Prisma } from '@prisma/client';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../env-var-templates/encryption.service.js';
import { CimdDeps, CimdError, fetchClientMetadataDocument } from './cimd-fetcher.js';

// A CIMD document is refetched after this long, so a client's changes reach us.
const CIMD_REFRESH_MS = 24 * 60 * 60 * 1000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Redirect URIs an app may register: https anywhere, or plain http only on
 * loopback (native clients such as Claude Code listen on a local port).
 */
export function isAllowedRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
}

function displayName(metadata: { client_name?: string; client_uri?: string }, fallback: string): string {
  if (metadata.client_name?.trim()) return metadata.client_name.trim().slice(0, 100);
  try {
    return new URL(metadata.client_uri ?? fallback).hostname;
  } catch {
    return 'Unnamed app';
  }
}

/**
 * The apps that may ask STELLA users for access, for the SDK's OAuth handlers.
 * Two ways in: Dynamic Client Registration (the app POSTs its metadata to
 * /register) and Client ID Metadata Documents (the client_id is an https URL
 * serving the metadata, fetched on first use and cached).
 */
@Injectable()
export class OAuthClientsStore implements OAuthRegisteredClientsStore {
  private readonly logger = new Logger(OAuthClientsStore.name);
  // Tests swap the network out.
  cimdDeps: CimdDeps | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const row = await this.prisma.oAuthClient.findUnique({ where: { id: clientId } });
    if (clientId.startsWith('https://')) {
      const fresh = row?.metadataFetchedAt && Date.now() - row.metadataFetchedAt.getTime() < CIMD_REFRESH_MS;
      if (row && fresh) return this.toClientInformation(row);
      return this.fetchCimdClient(clientId, row ? this.toClientInformation(row) : undefined);
    }
    return row ? this.toClientInformation(row) : undefined;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> &
      Partial<Pick<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>>,
  ): Promise<OAuthClientInformationFull> {
    if (!client.redirect_uris?.length || !client.redirect_uris.every((uri) => isAllowedRedirectUri(uri))) {
      throw new InvalidClientMetadataError('redirect_uris must be https URLs, or http on localhost');
    }
    const authMethod = client.token_endpoint_auth_method ?? 'client_secret_post';
    if (authMethod !== 'none' && authMethod !== 'client_secret_post') {
      throw new InvalidClientMetadataError('token_endpoint_auth_method must be none or client_secret_post');
    }
    const clientId = client.client_id!;
    const { client_secret, client_secret_expires_at, ...metadata } = client;
    await this.prisma.oAuthClient.create({
      data: {
        id: clientId,
        name: displayName(metadata, clientId),
        source: OAuthClientSource.DCR,
        metadata: metadata as Prisma.InputJsonValue,
        clientSecretEncrypted: client_secret ? this.encryption.encrypt({ secret: client_secret }) : null,
        clientSecretExpiresAt: client_secret_expires_at ? new Date(client_secret_expires_at * 1000) : null,
      },
    });
    this.logger.log(`Registered OAuth client ${clientId} (${displayName(metadata, clientId)})`);
    return client as OAuthClientInformationFull;
  }

  private async fetchCimdClient(
    clientId: string,
    cached: OAuthClientInformationFull | undefined,
  ): Promise<OAuthClientInformationFull | undefined> {
    let metadata;
    try {
      metadata = await fetchClientMetadataDocument(clientId, this.cimdDeps);
    } catch (error) {
      // A client we already know keeps working through a passing outage.
      if (cached) {
        this.logger.warn(`Could not refresh client metadata ${clientId}, using the cached copy: ${error.message}`);
        return cached;
      }
      if (error instanceof CimdError) {
        this.logger.warn(`Rejected client metadata document ${clientId}: ${error.message}`);
        return undefined;
      }
      throw error;
    }
    if (!metadata.redirect_uris.every((uri) => isAllowedRedirectUri(uri))) {
      this.logger.warn(`Rejected client metadata document ${clientId}: redirect_uris must be https or loopback`);
      return undefined;
    }
    // CIMD clients have no shared secret: they are public clients using PKCE.
    const stored = { ...metadata, client_id: clientId, token_endpoint_auth_method: 'none' };
    const data = {
      name: displayName(metadata, clientId),
      metadata: stored as Prisma.InputJsonValue,
      metadataFetchedAt: new Date(),
    };
    await this.prisma.oAuthClient.upsert({
      where: { id: clientId },
      create: { id: clientId, source: OAuthClientSource.CIMD, ...data },
      update: data,
    });
    return stored as OAuthClientInformationFull;
  }

  private toClientInformation(row: {
    id: string;
    metadata: Prisma.JsonValue;
    clientSecretEncrypted: string | null;
    clientSecretExpiresAt: Date | null;
  }): OAuthClientInformationFull {
    const info = { ...(row.metadata as object), client_id: row.id } as OAuthClientInformationFull;
    if (row.clientSecretEncrypted) {
      info.client_secret = this.encryption.decrypt(row.clientSecretEncrypted).secret;
      if (row.clientSecretExpiresAt) info.client_secret_expires_at = Math.floor(row.clientSecretExpiresAt.getTime() / 1000);
    }
    return info;
  }
}
