// Example React component for `fairux scan examples/PricingCard.tsx`.
// Demonstrates the AST adapter: static JSX is analyzed; dynamic {expr} values stay UNKNOWN.

export function PricingCard({ price }: { price: string }) {
  return (
    <section className="plan">
      <h2>Pro plan</h2>
      {/* Static scarcity copy → flagged (scarcity/scarcity-phrase). */}
      <p className="urgent">Only 2 left at this price — today only!</p>
      {/* Free-trial CTA with no nearby renewal disclosure → flagged. */}
      <a className="cta" href="/signup">
        Start free trial
      </a>
      {/* Pre-checked marketing consent (literal `checked`) → flagged. */}
      <label>
        <input type="checkbox" checked />
        Email me product offers and partner promotions
      </label>
      {/* Dynamic price: the value is unknown to the static adapter, so no false claims. */}
      <p className="price">{price}</p>
    </section>
  );
}
