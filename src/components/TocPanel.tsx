import SidePanel from './SidePanel'

export interface TocItem {
  label: string
  href: string
  subitems?: TocItem[]
}

function flatten(items: TocItem[], depth = 0): { item: TocItem; depth: number }[] {
  const out: { item: TocItem; depth: number }[] = []
  for (const item of items) {
    out.push({ item, depth })
    if (item.subitems?.length) out.push(...flatten(item.subitems, depth + 1))
  }
  return out
}

export default function TocPanel({
  toc,
  onNavigate,
  onClose,
}: {
  toc: TocItem[]
  onNavigate: (href: string) => void
  onClose: () => void
}) {
  const rows = flatten(toc)
  return (
    <SidePanel title="目录" onClose={onClose}>
      {rows.length === 0 ? (
        <div className="empty">这本书没有目录信息。</div>
      ) : (
        rows.map(({ item, depth }, i) => (
          <div
            key={i}
            className="toc-item"
            style={{ paddingLeft: 16 + depth * 16 }}
            onClick={() => item.href && onNavigate(item.href)}
          >
            {item.label}
          </div>
        ))
      )}
    </SidePanel>
  )
}
