import { FlowSteps } from "./FlowSteps";

/** Blue band at the top of each flow page, like an OTA results header. */
export function FlowBand({ current, title, subtitle, children }: { current: number; title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="hero-band text-white">
      <div className="mx-auto max-w-[1440px] space-y-5 px-4 pt-6 pb-20 lg:px-8">
        <FlowSteps current={current} />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black md:text-3xl">{title}</h1>
            {subtitle && <p className="mt-1 max-w-2xl text-white/85">{subtitle}</p>}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

export function EmptyState({ title, body, href, cta }: { title: string; body: string; href: string; cta: string }) {
  return (
    <div className="mx-auto -mt-12 max-w-xl rounded-2xl border border-line bg-white p-8 text-center shadow-card">
      <p className="text-lg font-bold text-ink">{title}</p>
      <p className="mt-2 text-ink-2">{body}</p>
      <a href={href} className="mt-5 inline-flex rounded-xl bg-brand px-6 py-3 font-bold text-white hover:bg-brand-600">
        {cta}
      </a>
    </div>
  );
}
