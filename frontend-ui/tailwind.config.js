/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // =================================================================
      // STELLA Design System - Unified Color Palette
      // =================================================================
      colors: {
        // Primary backgrounds - warmer, softer tones for light mode
        surface: {
          DEFAULT: '#f8f7f4',      // Light mode surface - warm off-white
          secondary: '#f3f2ef',    // Light mode secondary - slightly darker warm
          tertiary: '#eceae6',     // Light mode tertiary
          dark: '#09090b',         // Dark mode surface (zinc-950)
          'dark-secondary': '#18181b', // Dark mode secondary (zinc-900)
          'dark-tertiary': '#27272a',  // Dark mode tertiary (zinc-800)
        },
        // Primary brand color - Neon Purple (vibrant for dark mode)
        primary: {
          50: '#faf5ff',
          100: '#f3e8ff',
          200: '#e9d5ff',
          300: '#d8b4fe',
          400: '#c084fc',
          500: '#a855f7',   // Main brand - vibrant purple
          600: '#9333ea',   // Darker variant
          700: '#7c3aed',   // Neon purple
          800: '#6b21a8',
          900: '#581c87',
        },
        // Text colors - softer, warmer tones
        content: {
          DEFAULT: '#2d2a26',      // Primary text light - warm dark
          secondary: '#5c5751',    // Secondary text light - warm gray
          tertiary: '#9a948c',     // Tertiary/muted light - warm muted
          inverse: '#fafafa',      // Primary text dark mode
          'inverse-secondary': '#a1a1aa', // Secondary text dark mode
          'inverse-tertiary': '#71717a',  // Tertiary text dark mode
        },
        // Border colors - warmer
        border: {
          DEFAULT: '#e5e2dc',      // Light mode border - warm
          secondary: '#d6d2ca',    // Stronger light border - warm
          dark: '#27272a',         // Dark mode border
          'dark-secondary': '#3f3f46', // Stronger dark border
        },
      },

      // =================================================================
      // Typography - Single font family (Inter) with clear hierarchy
      // =================================================================
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      fontSize: {
        // Display sizes - for hero text
        'display-lg': ['3rem', { lineHeight: '1.1', letterSpacing: '-0.02em', fontWeight: '600' }],
        'display': ['2.25rem', { lineHeight: '1.2', letterSpacing: '-0.02em', fontWeight: '600' }],
        'display-sm': ['1.875rem', { lineHeight: '1.2', letterSpacing: '-0.01em', fontWeight: '600' }],
        // Headings
        'heading-lg': ['1.5rem', { lineHeight: '1.3', letterSpacing: '-0.01em', fontWeight: '600' }],
        'heading': ['1.25rem', { lineHeight: '1.4', letterSpacing: '-0.01em', fontWeight: '600' }],
        'heading-sm': ['1.125rem', { lineHeight: '1.4', fontWeight: '500' }],
        // Body text
        'body-lg': ['1rem', { lineHeight: '1.6', fontWeight: '400' }],
        'body': ['0.875rem', { lineHeight: '1.6', fontWeight: '400' }],
        'body-sm': ['0.8125rem', { lineHeight: '1.5', fontWeight: '400' }],
        // UI elements
        'ui': ['0.8125rem', { lineHeight: '1.4', fontWeight: '500' }],
        'ui-sm': ['0.75rem', { lineHeight: '1.4', fontWeight: '500' }],
        // Labels and captions
        'label': ['0.6875rem', { lineHeight: '1.4', letterSpacing: '0.02em', fontWeight: '500' }],
        'caption': ['0.6875rem', { lineHeight: '1.4', fontWeight: '400' }],
      },

      // =================================================================
      // Spacing scale - 4px base unit
      // =================================================================
      spacing: {
        '4.5': '1.125rem',   // 18px
        '13': '3.25rem',     // 52px
        '15': '3.75rem',     // 60px
        '18': '4.5rem',      // 72px
      },

      // =================================================================
      // Border radius - consistent scale
      // =================================================================
      borderRadius: {
        'sm': '0.375rem',    // 6px - small elements
        'DEFAULT': '0.5rem', // 8px - buttons, inputs
        'md': '0.625rem',    // 10px
        'lg': '0.75rem',     // 12px - cards
        'xl': '1rem',        // 16px - modals
        '2xl': '1.25rem',    // 20px - large cards
      },

      // =================================================================
      // Shadows - subtle and layered
      // =================================================================
      boxShadow: {
        'sm': '0 1px 2px 0 rgb(0 0 0 / 0.03)',
        'DEFAULT': '0 1px 3px 0 rgb(0 0 0 / 0.04), 0 1px 2px -1px rgb(0 0 0 / 0.04)',
        'md': '0 4px 6px -1px rgb(0 0 0 / 0.05), 0 2px 4px -2px rgb(0 0 0 / 0.05)',
        'lg': '0 10px 15px -3px rgb(0 0 0 / 0.05), 0 4px 6px -4px rgb(0 0 0 / 0.05)',
        'xl': '0 20px 25px -5px rgb(0 0 0 / 0.05), 0 8px 10px -6px rgb(0 0 0 / 0.05)',
        // Colored shadows for hover states - neon purple glow
        'primary': '0 4px 20px -2px rgb(168 85 247 / 0.4)',
        'primary-lg': '0 8px 30px -4px rgb(168 85 247 / 0.5)',
        // Dark mode shadows
        'dark': '0 1px 3px 0 rgb(0 0 0 / 0.2), 0 1px 2px -1px rgb(0 0 0 / 0.2)',
        'dark-lg': '0 10px 15px -3px rgb(0 0 0 / 0.3), 0 4px 6px -4px rgb(0 0 0 / 0.3)',
      },

      // =================================================================
      // Animations
      // =================================================================
      animation: {
        'fade-in': 'fadeIn 0.4s ease-out',
        'fade-in-up': 'fadeInUp 0.5s ease-out',
        'scale-in': 'scaleIn 0.3s ease-out',
        'pulse-subtle': 'pulseSubtle 2s ease-in-out infinite',
        'shimmer': 'shimmer 2s infinite',
        'gradient-shift': 'gradientShift 8s ease infinite',
        'pulse-glow': 'pulseGlow 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        pulseSubtle: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.7' },
        },
        shimmer: {
          '0%': { transform: 'translateX(-150%)' },
          '100%': { transform: 'translateX(150%)' },
        },
        gradientShift: {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        pulseGlow: {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '0.8' },
        },
      },

      // =================================================================
      // Transitions
      // =================================================================
      transitionDuration: {
        '250': '250ms',
      },
      transitionTimingFunction: {
        'smooth': 'cubic-bezier(0.4, 0, 0.2, 1)',
        'bounce': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
  },
  // coarse: = touch screens (phones, tablets), for tap-target spacing (#183)
  plugins: [({ addVariant }) => addVariant('coarse', '@media (pointer: coarse)')],
}
