// The folder 「第一次打开」 makes for what the user wants to do, named after
// the first few words of it (lib/first-open.ts). Shared with the page, which
// shows the name before 「开始」 is clicked.

const NAME_MAX = 10

// Letters and numbers of the first clause, at most NAME_MAX, nothing a file
// name can't hold. 「给我的小店做一个网站，要有…」 → 「给我的小店做一个网站」.
export function folderNameOf(text: string) {
  const clause = text.trim().split(/[，。！？；,.!?;:：\n]/)[0] ?? ""
  const plain = clause.replace(/[^\p{L}\p{N}]+/gu, "")
  return [...plain].slice(0, NAME_MAX).join("") || "新项目"
}
