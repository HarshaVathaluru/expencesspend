/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: [
    './views/**/*.html',
    './public/js/**/*.js'
  ],
  theme: {
    extend: {
      colors: {
        navy: {
          950: '#060B16',
          900: '#0B1220',
          800: '#111A2E',
          700: '#1A2742'
        }
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'Inter', 'sans-serif']
      }
    }
  },
  plugins: []
};
