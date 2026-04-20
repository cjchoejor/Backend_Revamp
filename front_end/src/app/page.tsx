import { S5ApiHealth } from "@/components/s5/s5-api-health";

export default function HomePage() {
  return (
    <main
      style={{
        padding: "2rem",
        maxWidth: 560,
        margin: "0 auto",
      }}
    >
      <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>LEGPHEL PMS</h1>
      <p style={{ color: "#444", marginBottom: "1.5rem" }}>Next.js front end — S5 API connectivity check.</p>
      <S5ApiHealth />
    </main>
  );
}
