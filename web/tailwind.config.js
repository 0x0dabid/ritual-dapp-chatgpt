/** @type {import('tailwindcss').Config} */
const theme = {
  extend: {
    colors: {
      ritual: {
        bg: '#0A0A0A',
        elevated: '#111827',
        green: '#19D184',
        lime: '#BFFF00',
        pink: '#FF1DCE',
        gold: '#FACC15',
        primary: '#F1F5F9',
        secondary: '#94A3B8',
      }
    },
    boxShadow: {
      'card': '0 4px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08)',
      'glow-green': '0 0 20px rgba(25,209,132,0.3)',
      'glow-pink':  '0 0 20px rgba(255,29,206,0.3)',
      'glow-lime':  '0 0 20px rgba(191,255,0,0.2)',
    },
    fontFamily: {
      archivo: ['Archivo Black', 'sans-serif'],
      barlow:  ['Barlow', 'sans-serif'],
      mono:    ['JetBrains Mono', 'monospace'],
    },
  },
};

module.exports = { content: require("./tailwind.config.require"), theme };
