import { Zap, Wrench, Check, ArrowRight } from 'lucide-react';
import Link from '@docusaurus/Link';
import { AnimatedSection } from './AnimatedSection';

const AgentTypes = () => {
  return (
    <section id="agents" className="section-dark section-alt">
      <div className="section-container">
        <AnimatedSection animation="fade-up">
          <div className="section-header">
            <div className="landing-eyebrow">
              Agents / <span className="landing-eyebrow-path">runtimes</span>
            </div>
            <h2 className="section-title">Choose Your Agent</h2>
            <p className="section-subtitle">
              Start with a ready-made conversation engine—or build your own
            </p>
          </div>
        </AnimatedSection>

        <div className="agents-grid">
          {/* stella-v2 */}
          <AnimatedSection animation="fade-up" delay={100}>
            <Link to="/docs/agents/stella-v2" className="agent-card">
              <div className="agent-card-badge agent-card-badge--primary">Full Featured</div>
              <div className="agent-card-header">
                <div className="agent-card-icon agent-card-icon--primary">
                  <Zap className="w-7 h-7" />
                </div>
                <h3 className="agent-card-title">stella-v2</h3>
                <p className="agent-card-desc">
                  Follows a plan through a guided conversation, or runs as a companion that keeps someone company and starts activities on request. Its persona sets the name, voice and identity.
                </p>
              </div>
              <div className="agent-card-features">
                <div className="agent-card-feature">
                  <span>Plan mode</span>
                  <Check className="agent-card-feature-check" />
                </div>
                <div className="agent-card-feature">
                  <span>Companion mode</span>
                  <Check className="agent-card-feature-check" />
                </div>
                <div className="agent-card-feature">
                  <span>Personas</span>
                  <Check className="agent-card-feature-check" />
                </div>
                <div className="agent-card-feature">
                  <span>Experts and tool calling</span>
                  <Check className="agent-card-feature-check" />
                </div>
              </div>
              <div className="agent-card-link agent-card-link--primary">
                Read the docs
                <ArrowRight className="w-4 h-4" />
              </div>
            </Link>
          </AnimatedSection>

          {/* Build Your Own */}
          <AnimatedSection animation="fade-up" delay={200}>
            <Link to="/docs/guides/build-your-own-agent" className="agent-card agent-card--custom">
              <div className="agent-card-badge agent-card-badge--blue">Customizable</div>
              <div className="agent-card-header">
                <div className="agent-card-icon agent-card-icon--blue">
                  <Wrench className="w-7 h-7" />
                </div>
                <h3 className="agent-card-title">Build Your Own</h3>
                <p className="agent-card-desc">
                  Full control over the conversation logic. STELLA handles the voice pipeline—you focus on the conversation.
                </p>
              </div>
              <div className="agent-card-custom-content">
                <ul className="agent-card-custom-list">
                  <li>Build your own workflows and custom tools</li>
                  <li>Plugin any LLM provider</li>
                </ul>
                <div className="agent-card-custom-link">
                  Read the guide
                  <ArrowRight className="w-4 h-4" />
                </div>
              </div>
            </Link>
          </AnimatedSection>
        </div>

        <AnimatedSection animation="fade-up" delay={300}>
          <p className="agents-deprecated-note">
            stella-light is deprecated since 1.3.0: existing deployments keep running, but new work should use stella-v2.{' '}
            <Link to="/docs/agents/stella-light-agent">Why, and how to migrate</Link>
          </p>
        </AnimatedSection>
      </div>
    </section>
  );
};

export default AgentTypes;
