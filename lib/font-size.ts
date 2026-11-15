// The page's text size, picked in the settings menu (t_98e8844e). It sets the
// root font size as a percentage of the browser's own, so everything sized in
// rem (Tailwind's text, spacing and boxes) grows or shrinks together. Text
// sizes written in px don't follow it: write them in rem (text-[0.6875rem],
// not text-[11px]). Not CSS `zoom`: that also scales 100dvh and the
// coordinates popups are placed by, and the page ran off the window.
export const FONT_SIZES = [
  { id: "s", label: "小", percent: 90 },
  { id: "m", label: "标准", percent: 100 },
  { id: "l", label: "大", percent: 112.5 },
  { id: "xl", label: "特大", percent: 125 },
] as const

export type FontSizeId = (typeof FONT_SIZES)[number]["id"]

export const FONT_SIZE_KEY = "bench-font-size"

// Run in <head> before the page paints (app/layout.tsx), so a reload doesn't
// flash at the standard size first. Keep it in step with FONT_SIZES.
export const FONT_SIZE_SCRIPT = `try{var p={${FONT_SIZES.map((size) => `${size.id}:${size.percent}`).join(",")}}[localStorage.getItem(${JSON.stringify(FONT_SIZE_KEY)})];if(p&&p!==100)document.documentElement.style.fontSize=p+"%"}catch(e){}`
