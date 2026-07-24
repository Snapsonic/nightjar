import { Hero } from "@/components/hero";
import { Why } from "@/components/why";
import { HowItWorks } from "@/components/how-it-works";
import { Comparison } from "@/components/comparison";
import { OpenSource } from "@/components/open-source";
import { Pricing } from "@/components/pricing";
import { Faq } from "@/components/faq";
import { Section } from "@/components/section";

export default function HomePage() {
  return (
    <>
      <Hero />
      <Why />
      <HowItWorks />
      <Comparison />
      <OpenSource />
      <Pricing />
      <Section id="faq" number="06" eyebrow="questions">
        <h2 className="max-w-2xl text-balance text-3xl font-semibold tracking-tight text-ink-100 sm:text-4xl">
          Asked in the small hours.
        </h2>
        <div className="mt-10 max-w-3xl">
          <Faq />
        </div>
      </Section>
    </>
  );
}
