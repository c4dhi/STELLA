import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Eye,
  EyeOff,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { safeNextPath } from '../lib/safeNextPath';
import {
  OnboardingLayout,
  OnboardingCard,
  StellaBranding,
  GradientButton,
  OnboardingInput,
} from '../components/onboarding';

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const nextPath = safeNextPath(searchParams.get('next')) ?? '/dashboard';
  const [isSignup, setIsSignup] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Auth store
  const {
    login,
    signup,
    isLoading,
    error,
    signupSuccess,
    isAuthenticated,
    clearError,
  } = useAuthStore();

  // Form State
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    name: '',
  });

  // Redirect if already authenticated
  useEffect(() => {
    if (isAuthenticated) {
      navigate(nextPath, { replace: true });
    }
  }, [isAuthenticated, navigate, nextPath]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();

    try {
      if (isSignup) {
        await signup(formData.email, formData.password, formData.name);
      } else {
        await login(formData.email, formData.password);
      }
    } catch (err) {
      console.error('Auth error:', err);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const toggleMode = () => {
    setIsSignup(!isSignup);
    clearError();
    setFormData({ email: '', password: '', name: '' });
  };

  return (
    <OnboardingLayout>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className="w-full max-w-[440px]"
      >
        {/* STELLA Branding */}
        <StellaBranding />

        {/* Login Card */}
        <OnboardingCard
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          contentClassName="p-8 sm:p-10"
        >
          {/* Header */}
          <div className="mb-8 text-center">
            <motion.div
              key={isSignup ? 'signup-h' : 'signin-h'}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              <h2 className="text-2xl font-light text-content dark:text-content-inverse mb-2">
                {isSignup ? 'Request Access' : 'Welcome Back'}
              </h2>
              <p className="text-content-tertiary dark:text-content-inverse-tertiary text-sm font-light">
                {isSignup
                  ? 'Submit your request. An admin will review and approve your access.'
                  : nextPath.startsWith('/oauth/consent')
                    ? 'Sign in to STELLA to connect the app.'
                    : 'Sign in to continue to your dashboard.'}
              </p>
            </motion.div>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            <AnimatePresence mode="popLayout">
              {isSignup && (
                <motion.div
                  initial={{ opacity: 0, height: 0, overflow: 'hidden' }}
                  animate={{ opacity: 1, height: 'auto', overflow: 'visible' }}
                  exit={{ opacity: 0, height: 0, overflow: 'hidden' }}
                >
                  <OnboardingInput
                    type="text"
                    name="name"
                    label="Name"
                    value={formData.name}
                    onChange={handleInputChange}
                    required={isSignup}
                    placeholder="Richard Hendricks"
                  />
                </motion.div>
              )}
            </AnimatePresence>

            <OnboardingInput
              type="email"
              name="email"
              label="Email"
              value={formData.email}
              onChange={handleInputChange}
              required
              placeholder="richard@piedpiper.com"
            />

            <div className="space-y-2 group">
              <div className="flex justify-between items-center ml-1">
                <label className="text-xs font-medium tracking-wider uppercase transition-colors text-content-secondary dark:text-content-inverse-tertiary group-focus-within:text-neutral-900 dark:group-focus-within:text-primary-400">
                  Password
                </label>
                {!isSignup && (
                  <button
                    type="button"
                    className="text-xs text-content-tertiary dark:text-content-inverse-tertiary hover:text-content dark:hover:text-content-inverse transition-colors"
                  >
                    Forgot?
                  </button>
                )}
              </div>
              <div className="relative transition-all duration-200 rounded-lg border border-border dark:border-border-dark bg-white dark:bg-surface-dark-secondary hover:border-border-secondary dark:hover:border-border-dark-secondary focus-within:border-neutral-900 dark:focus-within:border-primary-400 focus-within:ring-2 focus-within:ring-neutral-900/20 dark:focus-within:ring-primary-400/20">
                <input
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  value={formData.password}
                  onChange={handleInputChange}
                  required
                  className="w-full bg-transparent border-none px-3.5 py-2.5 text-body text-content dark:text-content-inverse placeholder-content-tertiary dark:placeholder-content-inverse-tertiary focus:ring-0 focus:outline-none pr-12"
                  placeholder="middleout123"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-content-tertiary dark:text-content-inverse-tertiary hover:text-content dark:hover:text-content-inverse transition-colors"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {/* Notifications */}
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="bg-red-500/10 border border-red-500/20 text-red-700 dark:text-red-200 text-xs p-3 rounded-lg flex items-center gap-3"
                >
                  <AlertCircle size={14} className="shrink-0" />
                  <span>{error}</span>
                </motion.div>
              )}
              {signupSuccess && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-200 text-xs p-3 rounded-lg flex items-center gap-3"
                >
                  <CheckCircle2 size={14} className="shrink-0" />
                  <span>{signupSuccess}</span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Submit Button */}
            <GradientButton
              type="submit"
              isLoading={isLoading}
              loadingText={isSignup ? 'Submitting...' : 'Signing in...'}
              className="mt-2"
            >
              <span className="text-sm font-medium">
                {isSignup ? 'Request Access' : 'Sign In'}
              </span>
              <ArrowRight
                size={16}
                className="group-hover:translate-x-1 transition-transform"
              />
            </GradientButton>
          </form>

          {/* Toggle Sign Up / Sign In */}
          <div className="mt-6 pt-6 border-t border-border dark:border-border-dark text-center">
            <p className="text-content-secondary dark:text-content-inverse-secondary text-sm">
              {isSignup ? 'Already have access?' : 'Need access?'}
              <button
                onClick={toggleMode}
                className="ml-2 text-neutral-900 dark:text-primary-400 hover:text-neutral-700 dark:hover:text-primary-300 transition-colors duration-200 font-medium"
              >
                {isSignup ? 'Sign In' : 'Request Access'}
              </button>
            </p>
          </div>
        </OnboardingCard>

        {/* Footer */}
        <div className="mt-6 text-center space-y-2">
          <p className="text-content-tertiary dark:text-content-inverse-tertiary text-xs">
            Secure • Private • Encrypted
          </p>
          <Link
            to="/status"
            className="inline-block text-content-tertiary dark:text-content-inverse-tertiary hover:text-content-secondary dark:hover:text-content-inverse-secondary text-xs underline-offset-2 hover:underline"
          >
            System status
          </Link>
        </div>
      </motion.div>
    </OnboardingLayout>
  );
}
