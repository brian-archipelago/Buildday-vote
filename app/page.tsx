import Link from "next/link";

export default function Landing() {
  return (
    <main className="min-h-screen bg-aurora">
      <div className="max-w-3xl mx-auto px-6 py-24">
        <div className="text-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/10 border border-white/10 px-3 py-1 text-xs uppercase tracking-widest">
            Live Hackathon Vote
          </div>
          <h1 className="mt-6 font-display text-5xl sm:text-7xl font-bold tracking-tight bg-gradient-to-r from-brand-mint via-white to-brand-subtle-blue bg-clip-text text-transparent">
            AI-Powered Pitch Poll
          </h1>
          <p className="mt-4 text-lg text-white/70">
            Three surfaces, one live poll. Pick yours.
          </p>
        </div>

        <div className="mt-14 grid gap-4 sm:grid-cols-3">
          <RoleCard
            href="/display"
            title="Display"
            subtitle="Projector / big screen"
            emoji="🖥️"
          />
          <RoleCard
            href="/admin"
            title="Admin"
            subtitle="Mic operator (phone)"
            emoji="🎙️"
          />
          <RoleCard
            href="/vote"
            title="Vote"
            subtitle="Audience ballot"
            emoji="🗳️"
          />
        </div>
      </div>
    </main>
  );
}

function RoleCard({
  href,
  title,
  subtitle,
  emoji,
}: {
  href: string;
  title: string;
  subtitle: string;
  emoji: string;
}) {
  return (
    <Link
      href={href}
      className="card hover:bg-white/10 hover:border-brand-blue/40 transition flex flex-col items-start gap-2"
    >
      <div className="text-4xl">{emoji}</div>
      <div className="font-display text-xl font-bold">{title}</div>
      <div className="text-sm text-white/60">{subtitle}</div>
    </Link>
  );
}
