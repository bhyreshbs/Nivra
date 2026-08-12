/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./viewer/**/*.{html,js}"],
  darkMode: 'class',
  theme: {
      extend: {
          fontFamily: {
              sans: ['Inter', 'Segoe UI', 'sans-serif'],
          },
          colors: {
              nivra: {
                  accent: '#3B82F6', // A refined blue accent
                  accentHover: '#2563EB',
              },
              ui: {
                  bg: '#F3F4F6',      // Canvas background
                  surface: '#FFFFFF', // Toolbars, panels
                  border: '#E5E7EB',
                  text: '#111827',
                  textMuted: '#6B7280',
                  
                  // Dark mode specific (for the UI itself, separate from PDF modes)
                  darkBg: '#111827',
                  darkSurface: '#1F2937',
                  darkBorder: '#374151',
                  darkText: '#F9FAFB',
                  darkTextMuted: '#9CA3AF'
              }
          },
          boxShadow: {
              'panel': '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06), 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
              'page': '0 2px 4px rgba(0,0,0,0.1), 0 0 2px rgba(0,0,0,0.1)'
          }
      }
  },
  plugins: [],
}
