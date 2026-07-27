export function DeskPlaceholder({
  eyebrow,
  title,
  lead,
}: {
  eyebrow: string;
  title: string;
  lead: string;
}) {
  return (
    <section className="view">
      <div className="eyebrow">{eyebrow}</div>
      <h1 className="h-lg" style={{ margin: "4px 0 6px" }}>
        {title}
      </h1>
      <p className="lead">{lead}</p>
      <div className="card" style={{ marginTop: 18, padding: "26px 20px", textAlign: "center" }}>
        <p className="lead" style={{ margin: "0 auto" }}>
          This page is coming next as we build the desk page by page.
        </p>
      </div>
    </section>
  );
}
