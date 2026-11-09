"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { Bot } from "@/components/room/bot";
import { NameField } from "@/components/room/name-field";
import { Button } from "@/components/ui/button";
import { kindById } from "@/lib/kinds";

// Opened from the debug menu. Everything here lives in this component's state:
// it highlights parts of the real page and shows sketches, never calls the API,
// never writes the room or localStorage. It only asks the page to open or close
// the 接入 dialog, which is the real one. The exception is the first step's
// name field (NameField), which saves the user's name: that is a setting.
export const TOUR_START = "bench-tour-start";
export const TOUR_JOIN = "bench-tour-join";

type Step = {
  // One selector, or several in order of preference: the first that is on
  // screen wins, and `bodies[i]` (when given) is the text for the i-th one.
  target: string | string[] | null;
  title: string;
  body: string;
  bodies?: string[];
  sketch?: "project" | "pick" | "register" | "say" | "seat" | "mention";
  dialog?: boolean;
  finale?: boolean;
};

// Setup only, from nothing to the first @. How to use the room is the video's job.
const STEPS: Step[] = [
  {
    target: null,
    title: "欢迎使用并坐",
    body: "我是你的小向导。接下来我会带着你一直配置到可以用，大约三分钟。引导里都只是演示，不会真的建项目，也不会写进房间，只有你的名字会存下来。",
  },
  {
    // Wide screens: the project rail. Middle: its narrow icon strip. Narrow: the
    // project name in the header.
    target: [
      '[data-tour="project-rail"]',
      'nav[aria-label="项目"]',
      '[data-tour="project"]',
    ],
    title: "先创建一个项目",
    body: "一个项目就是一间房，每个项目一张长凳。点栏底部的「新建项目」，起个名字，项目目录可以不填。建好后会自动弹出接入页。",
    bodies: [
      "一个项目就是一间房，每个项目一张长凳。点栏底部的「新建项目」，起个名字，项目目录可以不填。建好后会自动弹出接入页。",
      "一个项目就是一间房，每个项目一个头像。点栏底部的「+」新建项目，起个名字，项目目录可以不填。建好后会自动弹出接入页。",
      "一个项目就是一间房。点这里的项目名，选「新建项目…」，起个名字，项目目录可以不填。建好后会自动弹出接入页。",
    ],
    sketch: "project",
  },
  {
    target: '[data-tour="j-pick"]',
    title: "接入页：选要接哪几个 AI",
    body: "这就是接入页。先选你电脑上装了的 AI，可以多选。列表里没有的，把页面下方那段说明复制给它也能接。",
    sketch: "pick",
    dialog: true,
  },
  {
    target: '[data-tour="j-register"]',
    title: "运行一次注册命令",
    body: "选好后这里会给出一条命令：点「替我运行」，或复制到终端里跑。每个 AI 只做一次，换项目、重启电脑都不用重做。",
    sketch: "register",
    dialog: true,
  },
  {
    target: '[data-tour="j-say"]',
    title: "让它入座",
    body: "到那个 AI 的会话里，把这句话说给它，它就入座了。不想自己开会话的话，点下面的「新的 xx 会话」，房间会在后台替你开好。",
    sketch: "say",
    dialog: true,
  },
  {
    target: '[data-tour="roster"]',
    title: "看它有没有入座",
    body: "回到主页面，左栏的头像亮起来就成功了。写着「离线 · 点名会唤起」说明房间能把它叫醒；还写着「还没接入」，就回到上一页再看一遍注册命令。",
    sketch: "seat",
  },
  {
    target: null,
    title: "配置完成！",
    body: "现在可以试着 @ 它一下了：在底部输入框写「@Claude 你好」，按回车。具体怎么用，看视频。",
    sketch: "mention",
    finale: true,
  },
];

type Box = { x: number; y: number; w: number; h: number };

function Sketch({ kind }: { kind: NonNullable<Step["sketch"]> }) {
  const frame =
    "mt-3 rounded-xl border border-dashed border-foreground/20 bg-muted/50 p-3 text-xs";
  const chip = "rounded-full border px-2 py-0.5";
  if (kind === "project")
    return (
      <div className={frame}>
        <p className="rounded-lg border border-dashed border-foreground/30 px-2 py-1.5 text-center">
          ＋ 新建项目
        </p>
      </div>
    );
  if (kind === "pick")
    return (
      <div className={frame}>
        <p className="mt-0.5 flex flex-wrap gap-1.5">
          <span className={`${chip} border-primary bg-primary/15`}>
            ✓ Claude
          </span>
          <span className={`${chip} border-primary bg-primary/15`}>✓ GPT</span>
          <span className={chip}>DeepSeek</span>
          <span className={chip}>Gemini</span>
        </p>
      </div>
    );
  if (kind === "register")
    return (
      <div className={frame}>
        <p className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-foreground/10 px-2 py-1">
            scripts/register-mcp.sh claude
          </code>
          <span className="shrink-0 rounded bg-primary/15 px-2 py-1">
            替我运行
          </span>
        </p>
      </div>
    );
  if (kind === "say")
    return (
      <div className={frame}>
        <p className="rounded bg-foreground/10 px-2 py-1">
          加入并坐房间「我的项目」，名字叫 Claude
        </p>
      </div>
    );
  if (kind === "seat")
    return (
      <div className={frame}>
        <p className="flex items-center justify-between">
          <span className="font-medium">Claude</span>
          <span className="text-muted-foreground">离线 · 点名会唤起</span>
        </p>
        <p className="mt-1 flex items-center justify-between">
          <span className="font-medium">DeepSeek</span>
          <span className="text-muted-foreground">还没接入</span>
        </p>
      </div>
    );
  return (
    <div className={frame}>
      <p>@Claude 你好</p>
    </div>
  );
}

// A little longer than the card's 300ms glide, so it has landed.
const CARD_SETTLE = 550;

const COLORS = [
  "#d97757",
  "#4f7cff",
  "#10a37f",
  "#f5b301",
  "#a855f7",
  "#ef4444",
];

// Paper bits shot out of the middle of the card, half to each side, flying on
// off the screen. Skipped for reduced motion.
function Confetti({ origin }: { origin: () => { x: number; y: number } }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = host.current;
    if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const animations: Animation[] = [];
    // Wait for the card to finish gliding to the middle, then shoot from where it ended up.
    const timer = window.setTimeout(() => {
      const from = origin();
      for (let i = 0; i < 120; i++) {
        const bit = document.createElement("span");
        const dir = i % 2 === 0 ? -1 : 1;
        bit.style.cssText = `position:absolute;left:${from.x}px;top:${from.y}px;width:${6 + Math.random() * 6}px;height:${8 + Math.random() * 8}px;background:${COLORS[i % COLORS.length]};border-radius:2px`;
        node.appendChild(bit);
        // Far enough sideways to be past the screen edge, with room to spare.
        const edge = dir < 0 ? from.x : w - from.x;
        const dx = dir * (edge + 120 + Math.random() * 320);
        const lift = h * (0.15 + Math.random() * 0.45);
        const fall = h * (0.5 + Math.random() * 0.6);
        const spin = (Math.random() - 0.5) * 1800;
        const frames: Keyframe[] = [];
        for (let k = 0; k <= 24; k++) {
          const t = k / 24;
          // Straight out sideways, up first and then pulled down.
          const y = -lift * 4 * t * (1 - t) + fall * t * t * t;
          frames.push({
            transform: `translate(${dx * t}px,${y}px) rotate(${spin * t}deg)`,
            opacity: t > 0.9 ? (1 - t) * 10 : 1,
            offset: t,
          });
        }
        animations.push(
          bit.animate(frames, {
            duration: 1800 + Math.random() * 1000,
            delay: Math.random() * 120,
            fill: "both",
            easing: "cubic-bezier(.15,.6,.4,1)",
          }),
        );
      }
    }, CARD_SETTLE);
    return () => {
      window.clearTimeout(timer);
      for (const animation of animations) animation.cancel();
      node.replaceChildren();
    };
  }, [origin]);
  return (
    <div
      ref={host}
      className="pointer-events-none fixed inset-0 z-[110] overflow-hidden"
      aria-hidden="true"
    />
  );
}

export function Tour() {
  const [index, setIndex] = useState<number | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [hit, setHit] = useState(0);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const dialogOpen = useRef(false);
  const card = useRef<HTMLDivElement>(null);
  const cardCenter = useCallback(() => {
    const r = card.current?.getBoundingClientRect();
    return r
      ? { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }, []);

  useEffect(() => {
    const start = () => setIndex(0);
    window.addEventListener(TOUR_START, start);
    return () => window.removeEventListener(TOUR_START, start);
  }, []);

  const step = index === null ? null : STEPS[index];

  // Open the real 接入 dialog for its steps; close it when they are over.
  useEffect(() => {
    const want = Boolean(step?.dialog);
    if (want === dialogOpen.current) return;
    dialogOpen.current = want;
    window.dispatchEvent(new CustomEvent(TOUR_JOIN, { detail: want }));
  }, [step]);

  // The dialog animates in, so keep measuring while a step is up.
  useLayoutEffect(() => {
    if (!step) return;
    const measure = () => {
      setSize({ w: window.innerWidth, h: window.innerHeight });
      let next: Box | null = null;
      let which = 0;
      const targets = step.target ? [step.target].flat() : [];
      for (const [i, selector] of targets.entries()) {
        const r = document.querySelector(selector)?.getBoundingClientRect();
        if (r && r.width > 0) {
          next = { x: r.left, y: r.top, w: r.width, h: r.height };
          which = i;
          break;
        }
      }
      setHit(which);
      setBox((old) =>
        old &&
        next &&
        old.x === next.x &&
        old.y === next.y &&
        old.w === next.w &&
        old.h === next.h
          ? old
          : next,
      );
    };
    measure();
    const timer = window.setInterval(measure, 150);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", measure);
    };
  }, [step]);

  useEffect(() => {
    if (index === null) return;
    const onKey = (event: KeyboardEvent) => {
      // Arrows move the caret in the name field, not the tour.
      const typing =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement;
      if (event.key === "Escape") setIndex(null);
      else if (typing) return;
      else if (event.key === "ArrowRight")
        setIndex((i) =>
          i === null ? i : i + 1 >= STEPS.length ? null : i + 1,
        );
      else if (event.key === "ArrowLeft")
        setIndex((i) => (i === null ? i : Math.max(0, i - 1)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index]);

  if (index === null || !step) return null;
  const last = index === STEPS.length - 1;
  const centered = step.target === null;
  const pad = 6;
  const cardW = Math.min(centered ? 380 : 300, size.w - 24);
  let left = (size.w - cardW) / 2;
  let top = Math.max(12, size.h / 2 - 200);
  if (box && !centered) {
    const right = box.x + box.w + pad + 12;
    const leftSide = box.x - pad - 12 - cardW;
    let overlaps = false;
    if (right + cardW <= size.w - 12) left = right;
    else if (leftSide >= 12) left = leftSide;
    else {
      left = Math.max(
        12,
        Math.min(size.w - cardW - 12, box.x + box.w / 2 - cardW / 2),
      );
      overlaps = true;
    }
    top = overlaps ? box.y + box.h + pad + 12 : box.y;
    top = Math.max(12, Math.min(size.h - 380, top));
  }
  const claude = kindById("claude");

  // On the body, not inside <main>: the dialog portals there and must not cover this.
  return createPortal(
    <div className="fixed inset-0 z-[100]" role="dialog" aria-label="新手引导">
      <div className="absolute inset-0" onClick={() => setIndex(null)} />
      {box && !centered ? (
        <div
          className="pointer-events-none absolute rounded-2xl ring-2 ring-primary transition-all duration-300 ease-out motion-reduce:transition-none"
          style={{
            left: box.x - pad,
            top: box.y - pad,
            width: box.w + pad * 2,
            height: box.h + pad * 2,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
          }}
        />
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-black/55" />
      )}
      <div
        ref={card}
        className="absolute rounded-2xl border bg-popover p-4 text-popover-foreground shadow-2xl transition-all duration-300 ease-out motion-reduce:transition-none"
        style={{ left, top, width: cardW }}
      >
        <button
          type="button"
          aria-label="退出引导"
          className="absolute top-3 right-3 rounded p-0.5 hover:bg-muted"
          onClick={() => setIndex(null)}
        >
          <X className="size-4" />
        </button>
        {claude ? (
          <div className={centered ? "mb-2 flex justify-center" : "mb-1 -ml-1"}>
            <Bot
              shape={claude.shape}
              color={claude.color}
              size={centered ? 72 : 40}
              status="idle"
              watch
            />
          </div>
        ) : null}
        <h2
          className={`${centered ? "text-center text-base" : "pr-6 text-sm"} font-semibold`}
        >
          {step.title}
        </h2>
        <p
          className={`${centered ? "text-center" : ""} mt-2 text-[13px] leading-6 text-muted-foreground`}
        >
          {step.bodies?.[hit] ?? step.body}
        </p>
        {step.sketch ? <Sketch kind={step.sketch} /> : null}
        {index === 0 ? <NameField onNext={() => setIndex(1)} /> : null}
        <div className="mt-4 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {index + 1} / {STEPS.length}
          </span>
          <div className="ml-auto flex gap-2">
            {index > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setIndex(index - 1)}
              >
                上一步
              </Button>
            ) : null}
            {index > 0 ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setIndex(last ? null : index + 1)}
              >
                {last ? "完成" : "下一步"}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      {step.finale ? <Confetti key={index} origin={cardCenter} /> : null}
    </div>,
    document.body,
  );
}
