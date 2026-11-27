import { MessageSquare, ArrowRight } from 'lucide-react';
import {
  OnboardingLayout,
  OnboardingCard,
  StellaBranding,
  GradientButton,
} from '../onboarding';

interface OrganizerMessageModalProps {
  message: string;
  /** Left out for public-link participants, whose names are generated. */
  participantName?: string;
  onContinue: () => void;
}

export default function OrganizerMessageModal({
  message,
  participantName,
  onContinue,
}: OrganizerMessageModalProps) {
  return (
    <OnboardingLayout>
      <div className="max-w-lg w-full">
        {/* STELLA Branding */}
        <StellaBranding />

        {/* Message Card */}
        <OnboardingCard
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          contentClassName="p-8"
        >
          {/* Header */}
          <div className="text-center mb-6">
            <div className="w-12 h-12 rounded-full bg-cyan-100 dark:bg-cyan-500/10 flex items-center justify-center mx-auto mb-4">
              <MessageSquare className="w-6 h-6 text-cyan-600 dark:text-cyan-400" />
            </div>
            <h2 className="text-xl font-medium text-content dark:text-content-inverse mb-2">
              Message from the Organizer
            </h2>
            <p className="text-content-secondary dark:text-content-inverse-secondary text-sm">
              {participantName
                ? `Hi ${participantName}, the session organizer has a message for you.`
                : 'The session organizer has a message for you.'}
            </p>
          </div>

          {/* Message Box */}
          <div className="mb-8">
            <div className="bg-surface-secondary dark:bg-surface-dark-tertiary border border-border dark:border-border-dark rounded-lg p-5">
              <p className="text-content dark:text-content-inverse text-sm leading-relaxed whitespace-pre-wrap">
                {message}
              </p>
            </div>
          </div>

          {/* Continue Button */}
          <GradientButton onClick={onContinue}>
            <span>Join Session</span>
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </GradientButton>
        </OnboardingCard>
      </div>
    </OnboardingLayout>
  );
}
