/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        teal: {
          50: '#fdfcfe', // replacing teal values if needed later. But standard tailwind works.
        }
      }
    },
  },
  plugins: [],
}
