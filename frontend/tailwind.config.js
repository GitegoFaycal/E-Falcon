/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#eef5fd',
          100: '#cde2fb',
          500: '#2a78d6',
          600: '#256abf',
          700: '#1c5cab',
          900: '#0d366b',
        },
      },
    },
  },
  plugins: [],
};
