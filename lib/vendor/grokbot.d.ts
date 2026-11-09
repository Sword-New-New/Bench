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
  /** false stops the idle tricks (spit, wink, surprise…). */
  mischief?: boolean
}

export type GrokBotShape = {
  name: string
  label: string
  /** Outline as x, y pairs, one per ray from the centre. */
  pts: Float32Array
  /** Where the eyes sit looking straight ahead: x, y, scale. */
  eye: [number, number, number]
}

declare class GrokBot {
  static SHAPES: Record<string, GrokBotShape>
  constructor(host: Element, options?: GrokBotOptions)
  state: GrokBotState
  setState(state: GrokBotState): this
  setShape(name: string, options?: { boing?: boolean }): this
  setColor(color: string): this
  morph(name: string): this
  bounce(strength?: number): this
  blink(double?: boolean): this
  look(x: number, y: number, hold?: number): this
  setExpression(name: string, instant?: boolean): this
  destroy(): void
}

export default GrokBot
