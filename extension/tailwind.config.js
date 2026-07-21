/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        ink: '#0B0F19',
        panel: '#111626',
        accent: '#6366F1',
        accent2: '#22D3EE',
        muted: '#8A93A6',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
