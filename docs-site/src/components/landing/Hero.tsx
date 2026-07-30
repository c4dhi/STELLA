import { ArrowRight, Github } from 'lucide-react';
import Link from '@docusaurus/Link';
import { Button } from '../ui/button';
import { AnimatedSection } from './AnimatedSection';
import HeroSphereDemo from './HeroSphereDemo';

const Hero = () => {
  return (
    <section className="hero-section">
      {/* Background with gradient glows */}
      <div className="hero-background" />

      {/* Terminal status bar */}
      <div className="hero-statusbar">
        <div className="hero-statusbar-inner">
          <div className="hero-statusbar-path">
            <span className="tilde">~</span>
            <span className="sep">/</span>
            <span>voice-research</span>
          </div>
          <div className="hero-statusbar-meta">
            <span>license: <span className="val">MIT</span></span>
            <span className="hide-sm">deploy: <span className="val">self-hosted</span></span>
            <span className="live"><span className="live-dot" />online</span>
          </div>
        </div>
      </div>

      <div className="hero-content">
        <div className="hero-inner">
          {/* Text column */}
          <div className="hero-col-text">
            <AnimatedSection animation="fade-up">
              <p className="hero-tagline">Open Source Infrastructure for Research</p>
            </AnimatedSection>

            <AnimatedSection animation="fade-up" delay={100}>
              <h1 className="hero-title">
                Focus on your research,
                <br />
                <span className="hero-title-gradient">STELLA handles the rest.</span>
              </h1>
            </AnimatedSection>

            <AnimatedSection animation="fade-up" delay={150}>
              <p className="hero-subtitle">
                STELLA lets researchers run voice conversations with participants—interviews, digital interventions, guided dialogues. Design the conversation without code, then run it on your own hardware with a single command.
              </p>
            </AnimatedSection>

            <AnimatedSection animation="fade-up" delay={300}>
              <div className="hero-buttons">
                <Button asChild size="lg" className="hero-btn-primary">
                  <Link to="/docs/guides/getting-started">
                    Get Started
                    <ArrowRight className="ml-2 w-5 h-5" />
                  </Link>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="outline"
                  className="hero-btn-secondary"
                >
                  <Link to="https://github.com/c4dhi/STELLA">
                    <Github className="mr-2 w-5 h-5" />
                    GitHub
                  </Link>
                </Button>
              </div>
            </AnimatedSection>

            <AnimatedSection animation="fade-up" delay={350}>
              <div className="hero-stats">
                <span className="hero-stat"><strong>100%</strong> open source</span>
                <span className="hero-stat"><strong>self-hosted</strong> by design</span>
                <span className="hero-stat"><strong>no-code</strong> plan builder</span>
              </div>
            </AnimatedSection>
          </div>

          {/* Visual column */}
          <AnimatedSection animation="fade-up" delay={400} className="hero-col-visual">
            <div className="hero-browser">
              <span className="hero-frame-tick hero-frame-tick--tl" />
              <span className="hero-frame-tick hero-frame-tick--tr" />
              <span className="hero-frame-tick hero-frame-tick--bl" />
              <span className="hero-frame-tick hero-frame-tick--br" />
              <div className="hero-browser-window">
                {/* Browser Header */}
                <div className="hero-browser-header">
                  <div className="hero-browser-dots">
                    <div className="hero-browser-dot hero-browser-dot--red" />
                    <div className="hero-browser-dot hero-browser-dot--yellow" />
                    <div className="hero-browser-dot hero-browser-dot--green" />
                  </div>
                  <div className="hero-browser-url">
                    <span>stella/voice-session</span>
                  </div>
                </div>
                {/* Content Area */}
                <div className="hero-browser-content">
                  <div className="hero-sphere-container">
                    <HeroSphereDemo />
                  </div>
                </div>
              </div>
              <div className="hero-browser-caption">
                <span>voice.session</span>
                <span className="is-accent">● live · real-time</span>
              </div>
            </div>
          </AnimatedSection>
        </div>
      </div>
    </section>
  );
};

export default Hero;
