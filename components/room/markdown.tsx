"use client"

import { createContext, Fragment, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { Check, Copy, Square, SquareCheck } from "lucide-react"

import { goto, openFile, showCommit } from "@/components/room/refs"
import { fileTarget, parseInline, parseMarkdown, refOf, safeHref, splitRefs, type Block, type Inline, type Ref } from "@/lib/markdown"
import { copyText, isShell, splitMentions } from "@/lib/text"

// A message drawn from its Markdown (lib/markdown.ts): sizes stay close to
// the chat text, so a reply with headings and a table still reads as a chat
// bubble. @-mentions are picked out in the text, not inside code or links.
// "inverse" is the user's own coloured bubble.

type Tone = "ink" | "inverse"

// Who wrote the message: a relative path in it is looked up in their folder first.
const From = createContext<string | undefined>(undefined)

export function Markdown({ text, names, tone = "ink", from }: { text: string; names: string[]; tone?: Tone; from?: string }) {
  const tree = useMemo(() => parseMarkdown(text), [text])
  return (
    <From.Provider value={from}>
      <Blocks blocks={tree} names={names} tone={tone} />
    </From.Provider>
  )
}

function Blocks({ blocks, names, tone, tight = false }: { blocks: Block[]; names: string[]; tone: Tone; tight?: boolean }) {
  return (
    <div className={tight ? "space-y-1" : "space-y-2"}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} names={names} tone={tone} />
      ))}
    </div>
  )
}

const HEADING = ["", "text-[1.05rem] font-semibold", "text-[1rem] font-semibold", "text-[0.95rem] font-semibold", "font-semibold", "font-semibold", "font-semibold"]

function BlockView({ block, names, tone }: { block: Block; names: string[]; tone: Tone }) {
  const inverse = tone === "inverse"
  const line = inverse ? "border-white/25" : "border-border"
  switch (block.t) {
    case "para":
      return (
        <p className="whitespace-pre-wrap">
          <Inlines nodes={parseInline(block.text)} names={names} tone={tone} />
        </p>
      )
    case "heading":
      return (
        <p role="heading" aria-level={block.level} className={`${HEADING[block.level]} pt-1 leading-snug`}>
          <Inlines nodes={parseInline(block.text)} names={names} tone={tone} />
        </p>
      )
    case "code":
      return <CodeBox code={block.text} lang={block.lang} tone={tone} />
    case "hr":
      return <hr className={`my-1 ${line}`} />
    case "quote":
      return (
        <blockquote className={`border-l-2 pl-3 ${inverse ? "border-white/40 text-white/85" : "border-border text-muted-foreground"}`}>
          <Blocks blocks={block.c} names={names} tone={tone} />
        </blockquote>
      )
    case "list": {
      const List = block.ordered ? "ol" : "ul"
      return (
        <List
          start={block.ordered && block.start !== 1 ? block.start : undefined}
          className={`space-y-1 pl-5 ${block.ordered ? "list-decimal" : "list-disc"} ${inverse ? "marker:text-white/70" : "marker:text-muted-foreground"}`}
        >
          {block.items.map((item, index) => {
            // - [ ] / - [x]: a task list item, drawn with its box.
            const first = item[0]
            const box = first?.t === "para" ? /^\[([ xX])\][ \t]+/.exec(first.text) : null
            if (!box || first?.t !== "para") {
              return (
                <li key={index} className="pl-0.5">
                  <Blocks blocks={item} names={names} tone={tone} tight />
                </li>
              )
            }
            const done = box[1] !== " "
            const Box = done ? SquareCheck : Square
            return (
              <li key={index} className="relative -ml-5 list-none pl-5">
                <Box
                  aria-label={done ? "已完成" : "未完成"}
                  className={`absolute top-[0.3em] left-0 size-[1.05em] ${done ? (inverse ? "text-white" : "text-emerald-600 dark:text-emerald-400") : "opacity-60"}`}
                />
                <div className={done ? "opacity-70" : ""}>
                  <Blocks blocks={[{ ...first, text: first.text.slice(box[0].length) }, ...item.slice(1)]} names={names} tone={tone} tight />
                </div>
              </li>
            )
          })}
        </List>
      )
    }
    case "table":
      return (
        <div className={`overflow-x-auto rounded-lg border ${line}`}>
          <table className="w-full border-collapse text-[0.82rem]">
            <thead className={inverse ? "bg-white/10" : "bg-muted/60"}>
              <tr>
                {block.head.map((cell, index) => (
                  <th key={index} className={`border-b px-2.5 py-1.5 font-semibold ${line} ${alignClass(block.align[index])}`}>
                    <Inlines nodes={parseInline(cell)} names={names} tone={tone} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className={`border-b last:border-b-0 ${line}`}>
                  {block.head.map((_, index) => (
                    <td key={index} className={`px-2.5 py-1.5 align-top ${alignClass(block.align[index])}`}>
                      <Inlines nodes={parseInline(row[index] ?? "")} names={names} tone={tone} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

function alignClass(align: "left" | "center" | "right" | null | undefined) {
  return align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left"
}

function Inlines({ nodes, names, tone, inLink = false }: { nodes: Inline[]; names: string[]; tone: Tone; inLink?: boolean }) {
  const inverse = tone === "inverse"
  return (
    <>
      {nodes.map((node, index): ReactNode => {
        switch (node.t) {
          case "text":
            return inLink ? <Fragment key={index}>{node.v}</Fragment> : <Words key={index} text={node.v} names={names} tone={tone} />
          case "code": {
            const ref = inLink ? null : refOf(node.v)
            if (ref) {
              return (
                <RefLink key={index} target={ref} tone={tone}>
                  <code className={`rounded px-1 py-px font-mono text-[0.82em] [overflow-wrap:anywhere] ${inverse ? "bg-white/18" : "bg-muted"}`}>{node.v}</code>
                </RefLink>
              )
            }
            return (
              <code
                key={index}
                className={`rounded px-1 py-px font-mono text-[0.82em] [overflow-wrap:anywhere] ${inverse ? "bg-white/18" : "bg-muted text-foreground"}`}
              >
                {node.v}
              </code>
            )
          }
          case "strong":
            return (
              <strong key={index} className="font-semibold">
                <Inlines nodes={node.c} names={names} tone={tone} inLink={inLink} />
              </strong>
            )
          case "em":
            return (
              <em key={index}>
                <Inlines nodes={node.c} names={names} tone={tone} inLink={inLink} />
              </em>
            )
          case "del":
            return (
              <del key={index} className="opacity-70">
                <Inlines nodes={node.c} names={names} tone={tone} inLink={inLink} />
              </del>
            )
          case "link": {
            const href = safeHref(node.href)
            const file = href ? null : fileTarget(node.href)
            if (file) {
              return (
                <RefLink key={index} target={file} tone={tone}>
                  <Inlines nodes={node.c} names={names} tone={tone} inLink />
                </RefLink>
              )
            }
            // Another link the page can't open: the text, with where it
            // points on hover.
            if (!href) {
              return (
                <span key={index} title={node.href} className="underline decoration-dotted underline-offset-2">
                  <Inlines nodes={node.c} names={names} tone={tone} inLink />
                </span>
              )
            }
            return (
              <a
                key={index}
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className={`underline underline-offset-2 [overflow-wrap:anywhere] ${inverse ? "decoration-white/60" : "text-mention decoration-mention/40 hover:decoration-mention"}`}
              >
                <Inlines nodes={node.c} names={names} tone={tone} inLink />
              </a>
            )
          }
        }
      })}
    </>
  )
}

function Words({ text, names, tone }: { text: string; names: string[]; tone: Tone }) {
  const parts = splitRefs(text)
  if (parts.length === 1 && !parts[0].ref) return <Mentions text={text} names={names} tone={tone} />
  return (
    <>
      {parts.map((part, index) =>
        part.ref ? (
          <RefLink key={index} target={part.ref} tone={tone}>
            {part.text}
          </RefLink>
        ) : (
          <Mentions key={index} text={part.text} names={names} tone={tone} />
        ),
      )}
    </>
  )
}

const REF_TITLE = { message: "跳到这条消息", task: "在待办里看", commit: "看这个提交", file: "在编辑器里打开" }

// An id, file or commit in a message, as a quiet link: dotted underline, so a
// reply full of file names doesn't turn blue all over.
function RefLink({ target, tone, children }: { target: Ref; tone: Tone; children: ReactNode }) {
  const from = useContext(From)
  const open = () => {
    if (target.kind === "message" || target.kind === "task") goto(target.kind, target.id)
    else if (target.kind === "commit") showCommit(target.hash, from)
    else if (target.kind === "file") void openFile(target.path, target.line, from)
  }
  const where = target.kind === "file" ? `${target.path}${target.line ? `:${target.line}` : ""}` : ""
  return (
    <button
      type="button"
      onClick={open}
      title={`${REF_TITLE[target.kind]}${where ? `：${where}` : ""}`}
      className={`inline cursor-pointer rounded-sm text-left underline decoration-dotted underline-offset-[3px] [overflow-wrap:anywhere] ${
        tone === "inverse" ? "decoration-white/60 hover:bg-white/15" : "decoration-foreground/40 hover:bg-mention/10 hover:text-mention hover:decoration-mention"
      }`}
    >
      {children}
    </button>
  )
}

function Mentions({ text, names, tone }: { text: string; names: string[]; tone: Tone }) {
  const mention =
    tone === "inverse" ? "rounded px-0.5 font-medium bg-white/18" : "rounded px-0.5 font-medium text-mention bg-mention/10"
  return (
    <>
      {splitMentions(text, names).map((part, index) =>
        part.mention ? (
          <span key={index} className={mention}>
            {part.text}
          </span>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  )
}

// A fenced block in a message: monospace, scrolls sideways rather than
// wrapping, with what language it is and a copy button. A shell session's
// copy leaves out the `$ ` prompts and the output lines (lib/text.ts copyText).
export function CodeBox({ code, lang, tone }: { code: string; lang: string; tone: Tone }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    const value = copyText({ text: code, lang })
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // No clipboard API (not a secure page): the old way.
      const area = document.createElement("textarea")
      area.value = value
      area.style.position = "fixed"
      area.style.opacity = "0"
      document.body.appendChild(area)
      area.select()
      document.execCommand("copy")
      area.remove()
    }
    setCopied(true)
  }
  const inverse = tone === "inverse"
  const label = lang || (isShell(lang) ? "命令" : "")
  return (
    <div
      className={`block overflow-hidden rounded-lg border text-left whitespace-normal ${
        inverse ? "border-white/20 bg-black/20" : "border-border bg-muted/60"
      }`}
    >
      <span
        className={`flex items-center justify-between gap-2 border-b px-2.5 py-1 text-[11px] ${
          inverse ? "border-white/15 text-white/75" : "border-border/70 text-muted-foreground"
        }`}
      >
        <span className="font-mono">{label}</span>
        <button
          type="button"
          onClick={copy}
          className={`flex items-center gap-1 rounded px-1 py-0.5 ${inverse ? "hover:bg-white/15" : "hover:bg-background hover:text-foreground"}`}
          title={isShell(lang) ? "复制命令（不带 $ 提示符和输出）" : "复制"}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "已复制" : "复制"}
        </button>
      </span>
      <code className="block overflow-x-auto px-2.5 py-2 font-mono text-[0.8rem] leading-relaxed whitespace-pre">
        {lang === "diff" || lang === "patch" ? <DiffLines code={code} inverse={inverse} /> : code}
      </code>
    </div>
  )
}

// A diff, coloured the way every review tool does: added lines green,
// removed red, hunk headers blue, file headers bold.
function DiffLines({ code, inverse }: { code: string; inverse: boolean }) {
  return (
    <>
      {code.split("\n").map((line, index) => {
        const kind = /^(\+\+\+|---) /.test(line) || /^diff --git /.test(line)
          ? "file"
          : line.startsWith("@@")
            ? "hunk"
            : line.startsWith("+")
              ? "add"
              : line.startsWith("-")
                ? "del"
                : "same"
        const style = inverse
          ? { add: "bg-emerald-400/25", del: "bg-red-400/25", hunk: "text-sky-200", file: "font-semibold", same: "" }[kind]
          : {
              add: "bg-emerald-500/12 text-emerald-800 dark:text-emerald-300",
              del: "bg-red-500/12 text-red-800 dark:text-red-300",
              hunk: "text-sky-700 dark:text-sky-300",
              file: "font-semibold",
              same: "",
            }[kind]
        return (
          <span key={index} className={`-mx-2.5 block px-2.5 ${style}`}>
            {line || " "}
          </span>
        )
      })}
    </>
  )
}
