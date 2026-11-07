import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle, Loader2, Clock, RefreshCw, MessageSquareText, ArrowRight } from 'lucide-react';
import { apiClient } from '../services/ApiClient';
import type {
  InvitationDetails,
  AcceptInvitationResponse,
  InvitationStatus,
} from '../lib/api-types';
import { checkMicrophonePermission } from '../lib/mediaDevices';
import TermsModal from '../components/participant/TermsModal';
import OrganizerMessageModal from '../components/participant/OrganizerMessageModal';
import PermissionsModal from '../components/participant/PermissionsModal';
import { isTextFace } from '../components/face/types';
import ParticipantSessionView from '../components/participant/ParticipantSessionView';
import {
  OnboardingLayout,
  OnboardingCard,
  StellaBranding,
} from '../components/onboarding';

// State machine states
type PageState =
  | 'LOADING'
  | 'ERROR'
  | 'TERMS_MODAL'
  | 'MESSAGE_MODAL'
  | 'PERMISSIONS_CHECK' // Device permissions screen
  | 'TEXT_READY' // Locked to the Text face: no devices needed
  | 'WAITING' // When participant is active, waiting in queue
  | 'SESSION_VIEW';

interface ConnectionInfo {
  token: string;
  serverUrl: string;
  roomName: string;
}

interface SessionData {
  participantId: string;
  participantName: string;
  identity: string;
  sessionId: string;
  authToken: string; // Participant JWT for API calls
  connectionInfo: ConnectionInfo;
  visualizerType: string | null;
  visualizerLocked: boolean;
  maxSessionDurationSeconds: number | null;
}

export default function ParticipantJoinPage() {
  const { token } = useParams<{ token: string }>();

  // State machine
  const [pageState, setPageState] = useState<PageState>('LOADING');
  const [error, setError] = useState<string | null>(null);

  // Invitation data
  const [invitation, setInvitation] = useState<InvitationDetails | null>(null);

  // Session data (after accepting invitation)
  const [sessionData, setSessionData] = useState<SessionData | null>(null);

  // Load invitation details
  useEffect(() => {
    if (!token) {
      setError('Invalid invitation link');
      setPageState('ERROR');
      return;
    }

    const loadInvitation = async () => {
      try {
        const data = await apiClient.getPublicInvitation(token);
        setInvitation(data);

        // Handle based on status
        if (data.status === 'PENDING') {
          // New invitation - show terms modal
          setPageState('TERMS_MODAL');
        } else if (data.status === 'ACCEPTED') {
          // Already accepted - check if we can rejoin
          if (data.participant?.isActive) {
            // Someone is currently using this session - wait
            setPageState('WAITING');
          } else {
            // Participant is not active - can rejoin directly
            handleRejoinInvitation();
          }
        } else {
          // EXPIRED or REVOKED
          const statusMessages: Record<InvitationStatus, string> = {
            PENDING: '',
            ACCEPTED: '',
            EXPIRED: 'This invitation has expired.',
            REVOKED: 'This invitation has been revoked.',
          };
          setError(
            statusMessages[data.status] ||
              'This invitation is no longer valid.',
          );
          setPageState('ERROR');
        }
      } catch (err: any) {
        console.error('Failed to load invitation:', err);
        if (err.statusCode === 404) {
          setError('Invitation not found. The link may be invalid or expired.');
        } else {
          setError(err.message || 'Failed to load invitation');
        }
        setPageState('ERROR');
      }
    };

    loadInvitation();
  }, [token]);

  // Auto-poll when in WAITING state to check if participant becomes inactive
  useEffect(() => {
    if (pageState !== 'WAITING' || !token) return;

    const POLL_INTERVAL = 5000; // Check every 5 seconds

    const checkAndRejoin = async () => {
      try {
        const data = await apiClient.getPublicInvitation(token);

        // If invitation was revoked or expired while waiting, show error
        if (data.status === 'REVOKED' || data.status === 'EXPIRED') {
          setError(
            data.status === 'REVOKED'
              ? 'This invitation has been revoked.'
              : 'This invitation has expired.',
          );
          setPageState('ERROR');
          return;
        }

        // If participant is no longer active, try to rejoin
        if (data.status === 'ACCEPTED' && !data.participant?.isActive) {
          // Attempt to rejoin - this will handle success or if someone else got there first
          try {
            const response: AcceptInvitationResponse =
              await apiClient.rejoinInvitation(token);
            setSessionData({
              participantId: response.participantId,
              participantName: response.participantName,
              identity: response.identity,
              sessionId: response.sessionId,
              authToken: response.token,
              connectionInfo: response.connectionInfo,
              visualizerType: response.visualizerType ?? null,
              visualizerLocked: response.visualizerLocked,
              maxSessionDurationSeconds: response.maxSessionDurationSeconds ?? null,
            });
            setPageState('SESSION_VIEW');
          } catch (rejoinErr: any) {
            // If rejoin fails because someone else joined, stay in waiting
            if (rejoinErr.message?.includes('currently in use')) {
              // Stay in WAITING state, poll will retry
            } else {
              console.error('Failed to auto-rejoin:', rejoinErr);
            }
          }
        }
      } catch (err) {
        console.error('Failed to check invitation status:', err);
        // Don't change state on poll errors, just log and retry
      }
    };

    const intervalId = setInterval(checkAndRejoin, POLL_INTERVAL);

    return () => clearInterval(intervalId);
  }, [pageState, token]);

  // Accept invitation and join session
  const handleAcceptInvitation = useCallback(async () => {
    if (!token) return;

    setPageState('LOADING');

    try {
      const response: AcceptInvitationResponse =
        await apiClient.acceptInvitation(token);

      setSessionData({
        participantId: response.participantId,
        participantName: response.participantName,
        identity: response.identity,
        sessionId: response.sessionId,
        authToken: response.token, // Participant JWT for API calls
        connectionInfo: response.connectionInfo,
        visualizerType: response.visualizerType ?? null,
        visualizerLocked: response.visualizerLocked,
        maxSessionDurationSeconds: response.maxSessionDurationSeconds ?? null,
      });

      setPageState('SESSION_VIEW');
    } catch (err: any) {
      console.error('Failed to accept invitation:', err);
      setError(err.message || 'Failed to join session');
      setPageState('ERROR');
    }
  }, [token]);

  // Check if we need to show permissions screen
  const checkAndProceed = useCallback(async () => {
    // Starts on the Text face: nothing is spoken, so no microphone or camera is
    // asked for. If the participant may switch faces, the session asks for the
    // devices when they switch to a voice face.
    if (invitation && isTextFace(invitation.visualizerType)) {
      setPageState('TEXT_READY');
      return;
    }

    const micPermission = await checkMicrophonePermission();

    if (micPermission === 'granted') {
      // Skip permissions screen, go straight to accept
      await handleAcceptInvitation();
    } else {
      // Show permissions screen
      setPageState('PERMISSIONS_CHECK');
    }
  }, [handleAcceptInvitation, invitation]);

  // Handle terms acceptance
  const handleTermsAccepted = useCallback(() => {
    if (invitation?.customMessage) {
      setPageState('MESSAGE_MODAL');
    } else {
      // No custom message, check permissions
      checkAndProceed();
    }
  }, [invitation, checkAndProceed]);

  // Handle message acknowledgment
  const handleMessageAcknowledged = useCallback(() => {
    checkAndProceed();
  }, [checkAndProceed]);

  // Handle permissions complete
  const handlePermissionsComplete = useCallback(async () => {
    await handleAcceptInvitation();
  }, [handleAcceptInvitation]);

  // Rejoin an already accepted invitation
  const handleRejoinInvitation = useCallback(async () => {
    if (!token) return;

    setPageState('LOADING');

    try {
      const response: AcceptInvitationResponse =
        await apiClient.rejoinInvitation(token);

      setSessionData({
        participantId: response.participantId,
        participantName: response.participantName,
        identity: response.identity,
        sessionId: response.sessionId,
        authToken: response.token, // Participant JWT for API calls
        connectionInfo: response.connectionInfo,
        visualizerType: response.visualizerType ?? null,
        visualizerLocked: response.visualizerLocked,
        maxSessionDurationSeconds: response.maxSessionDurationSeconds ?? null,
      });

      setPageState('SESSION_VIEW');
    } catch (err: any) {
      console.error('Failed to rejoin invitation:', err);
      // If participant is active, show waiting screen
      if (err.message?.includes('currently in use')) {
        setPageState('WAITING');
      } else {
        setError(err.message || 'Failed to rejoin session');
        setPageState('ERROR');
      }
    }
  }, [token]);

  // Retry joining (for waiting screen)
  const handleRetryJoin = useCallback(() => {
    handleRejoinInvitation();
  }, [handleRejoinInvitation]);

  return (
    <AnimatePresence mode="wait">
      {/* LOADING State */}
      {pageState === 'LOADING' && (
        <OnboardingLayout key="loading">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="text-center"
          >
            <Loader2 className="w-8 h-8 animate-spin text-neutral-400 dark:text-primary-400 mx-auto mb-4" />
            <p className="text-content-secondary dark:text-content-inverse-secondary text-sm">
              Loading invitation...
            </p>
          </motion.div>
        </OnboardingLayout>
      )}

      {/* ERROR State */}
      {pageState === 'ERROR' && (
        <OnboardingLayout key="error">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="max-w-md w-full"
          >
            {/* STELLA Branding */}
            <StellaBranding />

            {/* Error Card */}
            <OnboardingCard contentClassName="p-8">
              <div className="flex flex-col items-center text-center">
                <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-500/10 flex items-center justify-center mb-4">
                  <AlertCircle className="w-6 h-6 text-red-600 dark:text-red-400" />
                </div>
                <h2 className="text-lg font-medium text-content dark:text-content-inverse mb-2">
                  Unable to Join
                </h2>
                <p className="text-content-secondary dark:text-content-inverse-secondary text-sm">
                  {error}
                </p>
              </div>
            </OnboardingCard>
          </motion.div>
        </OnboardingLayout>
      )}

      {/* TERMS_MODAL State */}
      {pageState === 'TERMS_MODAL' && invitation && (
        <TermsModal
          key="terms"
          participantName={invitation.participantName}
          onAccept={handleTermsAccepted}
        />
      )}

      {/* MESSAGE_MODAL State */}
      {pageState === 'MESSAGE_MODAL' && invitation && (
        <OrganizerMessageModal
          key="message"
          message={invitation.customMessage!}
          participantName={invitation.participantName}
          onContinue={handleMessageAcknowledged}
        />
      )}

      {/* PERMISSIONS_CHECK State */}
      {pageState === 'PERMISSIONS_CHECK' && invitation && (
        <PermissionsModal
          key="permissions"
          isOpen={true}
          participantName={invitation.participantName}
          onComplete={handlePermissionsComplete}
        />
      )}

      {/* TEXT_READY State - a text-only session needs no devices */}
      {pageState === 'TEXT_READY' && invitation && (
        <OnboardingLayout key="text-ready">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="max-w-md w-full"
          >
            <StellaBranding />
            <OnboardingCard contentClassName="p-8">
              <div className="flex flex-col items-center text-center">
                <div className="w-12 h-12 rounded-full bg-violet-100 dark:bg-violet-500/10 flex items-center justify-center mb-4">
                  <MessageSquareText className="w-6 h-6 text-violet-700 dark:text-violet-300" />
                </div>
                <h2 className="text-lg font-medium text-content dark:text-content-inverse mb-2">
                  This conversation is in writing
                </h2>
                <p className="text-content-secondary dark:text-content-inverse-secondary text-sm mb-6">
                  You will type your answers. No microphone or camera is needed, and nothing is read aloud.
                  {!invitation.visualizerLocked && ' If you switch to voice later, we will ask for your microphone then.'}
                </p>
                <button
                  type="button"
                  onClick={() => void handlePermissionsComplete()}
                  className="w-full py-2.5 px-6 bg-neutral-900 hover:bg-neutral-800 dark:bg-white dark:hover:bg-neutral-100 text-white dark:text-neutral-900 rounded-lg font-medium text-sm transition-colors flex items-center justify-center gap-2"
                >
                  Start
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </OnboardingCard>
          </motion.div>
        </OnboardingLayout>
      )}

      {/* WAITING State - Session in use by another participant */}
      {pageState === 'WAITING' && invitation && (
        <OnboardingLayout key="waiting">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="max-w-md w-full"
          >
            {/* STELLA Branding */}
            <StellaBranding />

            {/* Waiting Card */}
            <OnboardingCard contentClassName="p-8">
              <div className="flex flex-col items-center text-center">
                <div className="w-12 h-12 rounded-full bg-amber-100 dark:bg-amber-500/10 flex items-center justify-center mb-4">
                  <Clock className="w-6 h-6 text-amber-600 dark:text-amber-400" />
                </div>
                <h2 className="text-lg font-medium text-content dark:text-content-inverse mb-2">
                  Session In Use
                </h2>
                <p className="text-content-secondary dark:text-content-inverse-secondary text-sm mb-4">
                  The session is currently being used by another participant.
                </p>

                {/* Auto-checking indicator */}
                <div className="flex items-center gap-2 text-content-tertiary dark:text-content-inverse-tertiary text-xs mb-6">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Auto-checking availability...</span>
                </div>

                {/* Participant name */}
                <div className="w-full py-3 px-4 bg-surface-secondary dark:bg-surface-dark-tertiary rounded-lg border border-border dark:border-border-dark mb-6">
                  <p className="text-content-tertiary dark:text-content-inverse-tertiary text-xs uppercase tracking-wider mb-1">
                    Joining as
                  </p>
                  <p className="text-content dark:text-content-inverse font-medium">
                    {invitation.participantName}
                  </p>
                </div>

                {/* Retry button */}
                <button
                  onClick={handleRetryJoin}
                  className="w-full py-2.5 px-6 bg-surface-secondary dark:bg-surface-dark-secondary hover:bg-surface-tertiary dark:hover:bg-surface-dark-tertiary border border-border dark:border-border-dark rounded-lg text-content dark:text-content-inverse font-medium text-sm transition-all duration-200 flex items-center justify-center gap-2"
                >
                  <RefreshCw className="w-4 h-4" />
                  Check Now
                </button>

                <p className="text-content-tertiary dark:text-content-inverse-tertiary text-xs mt-4">
                  You'll automatically join when available
                </p>
              </div>
            </OnboardingCard>
          </motion.div>
        </OnboardingLayout>
      )}

      {/* SESSION_VIEW State */}
      {pageState === 'SESSION_VIEW' && sessionData && (
        <ParticipantSessionView key="session" sessionData={sessionData} />
      )}
    </AnimatePresence>
  );
}
