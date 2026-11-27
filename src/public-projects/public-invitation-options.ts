/**
 * What every invitation created for a public-link participant carries from
 * the project's public setup. The welcome message becomes the invitation's
 * customMessage, so the participant join page shows it exactly as it shows
 * an organiser's message on a personal invite (#213).
 */
export function publicInvitationOptions(project: {
  publicVisualizerType: string | null;
  publicVisualizerLocked: boolean;
  publicWelcomeMessage: string | null;
}) {
  return {
    visualizerType: project.publicVisualizerType || undefined,
    visualizerLocked: project.publicVisualizerLocked,
    customMessage: project.publicWelcomeMessage || undefined,
  };
}
