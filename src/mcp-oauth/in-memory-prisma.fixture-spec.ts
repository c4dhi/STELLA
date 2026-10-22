import { randomUUID } from 'crypto';

/**
 * Test fixture (excluded from the build by its *spec.ts name, not run by jest):
 * just enough of PrismaService for the MCP sign-in tables that the real
 * OAuth services run against it unchanged.
 */
type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (
      cond &&
      typeof cond === 'object' &&
      !(cond instanceof Date) &&
      !Array.isArray(cond)
    ) {
      if ('lt' in cond)
        return value instanceof Date && value.getTime() < cond.lt.getTime();
      if ('none' in cond) return true; // relation filters are applied by the caller
    }
    return value === cond;
  });
}

function table(defaults: (data: Row) => Row = () => ({})) {
  const rows: Row[] = [];
  return {
    rows,
    async create({ data }: { data: Row }) {
      const row = {
        id: randomUUID(),
        createdAt: new Date(),
        ...defaults(data),
        ...data,
      };
      rows.push(row);
      return { ...row };
    },
    async createMany({ data }: { data: Row[] }) {
      for (const d of data)
        rows.push({
          id: randomUUID(),
          createdAt: new Date(),
          ...defaults(d),
          ...d,
        });
      return { count: data.length };
    },
    async findFirst({ where }: { where: Row }) {
      const row = rows.find((r) => matches(r, where));
      return row ? { ...row } : null;
    },
    async findMany({ where }: { where?: Row } = {}) {
      return rows.filter((r) => matches(r, where)).map((r) => ({ ...r }));
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return { ...row };
    },
    async updateMany({ where, data }: { where: Row; data: Row }) {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    async deleteMany({ where }: { where?: Row } = {}) {
      const keep = rows.filter((r) => !matches(r, where));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    },
  };
}

export function createInMemoryOAuthPrisma() {
  const oAuthClient = table();
  const oAuthAuthorizationRequest = table(() => ({
    status: 'PENDING',
    userId: null,
    approvedScopes: [],
    codeHash: null,
    codeExpiresAt: null,
    consumedAt: null,
    grantId: null,
  }));
  const oAuthGrant = table(() => ({ lastUsedAt: null, revokedAt: null }));
  const oAuthToken = table(() => ({ rotatedAt: null }));

  const findBy = (t: { rows: Row[] }, where: Row) =>
    t.rows.find((r) => matches(r, where));
  const withClient = (grant: Row) => ({
    ...grant,
    client: { ...findBy(oAuthClient, { id: grant.clientId }) },
  });

  return {
    oAuthClient: {
      ...oAuthClient,
      async findUnique({ where }: { where: Row }) {
        const row = findBy(oAuthClient, where);
        return row ? { ...row } : null;
      },
      async upsert({
        where,
        create,
        update,
      }: {
        where: Row;
        create: Row;
        update: Row;
      }) {
        const row = findBy(oAuthClient, where);
        if (row) return Object.assign(row, update);
        return oAuthClient.create({ data: create });
      },
    },
    oAuthAuthorizationRequest: {
      ...oAuthAuthorizationRequest,
      async findUnique({ where, include }: { where: Row; include?: Row }) {
        const row = findBy(oAuthAuthorizationRequest, where);
        if (!row) return null;
        return include?.client
          ? { ...row, client: { ...findBy(oAuthClient, { id: row.clientId }) } }
          : { ...row };
      },
    },
    oAuthGrant: {
      ...oAuthGrant,
      async findUnique({ where }: { where: Row }) {
        const row = findBy(oAuthGrant, where);
        return row ? { ...row } : null;
      },
      async findMany({ where }: { where?: Row } = {}) {
        return oAuthGrant.rows.filter((r) => matches(r, where)).map(withClient);
      },
    },
    oAuthToken: {
      ...oAuthToken,
      async findUnique({ where, include }: { where: Row; include?: Row }) {
        const row = findBy(oAuthToken, where);
        if (!row) return null;
        if (!include?.grant) return { ...row };
        const grant = findBy(oAuthGrant, { id: row.grantId })!;
        return {
          ...row,
          grant: include.grant.include?.client
            ? withClient(grant)
            : { ...grant },
        };
      },
    },
  };
}

export type InMemoryOAuthPrisma = ReturnType<typeof createInMemoryOAuthPrisma>;
