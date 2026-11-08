// Types for the parts of grokbot.js this app uses.

export type GrokBotState =
  | "idle"
  | "typing"
  | "working"
  | "done"
  | "alert"
  | "notify"
  | "sleeping"
  | "sad"
  | "listening"

export type GrokBotOptions = {
  shape?: string
  color?: string
  size?: number
  state?: GrokBotState
  expression?: string
  eyeColor?: string
  followPointer?: boolean
  autonomous?: boolean
  extent?: number
  still?: boolean
  eyeSize?: number
}

declare class GrokBot {
  constructor(host: Element, options?: GrokBotOptions)
  state: GrokBotState
  setState(state: GrokBotState): this
  setShape(name: string, options?: { boing?: boolean }): this
  setColor(color: string): this
  morph(name: string): this
  bounce(strength?: number): this
  blink(double?: boolean): this
  look(x: number, y: number, hold?: number): this
  destroy(): void
}

export default GrokBot
