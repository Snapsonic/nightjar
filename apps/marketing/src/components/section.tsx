import type { ReactNode } from "react";

type SectionProps = {
  id?: string;
  number: string;
  eyebrow: string;
  children: ReactNode;
  className?: string;
};

/**
 * Editorial section shell: a numbered mono label in the left margin on
 * desktop (above the content on mobile), content offset to the right.
 */
export function Section({
  id,
  number,
  eyebrow,
  children,
  className,
}: SectionProps) {
  return (
    <section
      id={id}
      className={`border-t border-line py-16 sm:py-24 ${className ?? ""}`}
    >
      <div className="mx-auto grid max-w-6xl gap-10 px-5 md:grid-cols-[190px_1fr] md:gap-8">
        <div>
          <p className="eyebrow md:sticky md:top-24">
            <span className="text-ink-600">{number}</span>
            <span aria-hidden="true"> — </span>
            {eyebrow}
          </p>
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}
