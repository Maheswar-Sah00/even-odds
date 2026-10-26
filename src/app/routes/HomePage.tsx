import {
  ArrowRight,
  Baby,
  BookOpen,
  Bike,
  LayoutDashboard,
  Music,
  Palette,
  ScanEye,
  Sparkle,
  Sprout,
  Tent,
  Trophy,
  Users,
  Waves,
} from 'lucide-react';
import { Link } from 'react-router';
import { BrandMark } from '../../components/BrandMark.tsx';
import { ButtonLink } from '../../components/ui/index.ts';
import { FairnessColumns } from './home/FairnessColumns.tsx';
import { Showcase } from './home/Showcase.tsx';
import { VerifySection } from './home/VerifySection.tsx';
import './home/home.css';

const PROGRAM_KINDS = [
  { icon: Tent, label: 'Summer camps' },
  { icon: Waves, label: 'Swim lessons' },
  { icon: Sprout, label: 'Community gardens' },
  { icon: Music, label: 'Music lessons' },
  { icon: Trophy, label: 'Youth leagues' },
  { icon: Palette, label: 'Art classes' },
  { icon: BookOpen, label: 'Library workshops' },
  { icon: Baby, label: 'Childcare places' },
  { icon: Bike, label: 'Holiday clubs' },
] as const;

const PROMISES = [
  {
    title: 'Fair by design',
    body: 'the lottery never reads when you applied, and a public random number announced in advance seeds every draw',
  },
  {
    title: 'Verifiable by anyone',
    body: 'inputs are frozen and hashed first, so families, journalists and judges can replay the draw in a browser',
  },
  {
    title: 'Human at the core',
    body: 'organisers see demand early and run the draw themselves, and every override needs a reason code before the freeze',
  },
] as const;

const AUDIENCES = [
  {
    icon: Users,
    tone: 'a',
    title: 'Families',
    body: 'Apply once, rank weeks, keep siblings together and reply to offers.',
    to: '/programs',
    cta: 'Browse programs',
  },
  {
    icon: LayoutDashboard,
    tone: 'b',
    title: 'Organisers',
    body: 'Configure sessions and priority zones, freeze, draw and run offers.',
    to: '/organiser',
    cta: 'Organiser console',
  },
  {
    icon: ScanEye,
    tone: 'c',
    title: 'Everyone else',
    body: 'Audit log, replay and fairness report, open without an account.',
    to: '/demo',
    cta: 'Start in the sandbox',
  },
] as const;

function Marquee() {
  const row = PROGRAM_KINDS.map(({ icon: Icon, label }) => (
    <li key={label}>
      <Icon size={26} strokeWidth={1.4} aria-hidden="true" />
      {label}
    </li>
  ));
  return (
    <section className="marquee" aria-labelledby="marquee-title">
      <h2 id="marquee-title" className="kicker">
        Built for programs like
      </h2>
      <div className="marquee__viewport">
        <ul className="marquee__track">
          {row}
          {/* Second copy for a seamless loop; hidden from assistive tech. */}
          {PROGRAM_KINDS.map(({ icon: Icon, label }) => (
            <li key={`${label}-2`} aria-hidden="true">
              <Icon size={26} strokeWidth={1.4} />
              {label}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Ogee dome (a pointed arch) centred at cx on the baseline y, for the skyline illustration. */
const dome = (cx: number, w: number, h: number, y: number) =>
  `L${String(cx - w / 2)} ${String(y)} C${String(cx - w / 2)} ${String(y - h * 0.85)} ${String(cx - w * 0.14)} ${String(y - h * 0.7)} ${String(cx)} ${String(y - h)} ` +
  `C${String(cx + w * 0.14)} ${String(y - h * 0.7)} ${String(cx + w / 2)} ${String(y - h * 0.85)} ${String(cx + w / 2)} ${String(y)}`;

const skyline = (y: number, domes: [number, number, number][]) => `M0 ${String(y)} ${domes.map(([cx, w, h]) => dome(cx, w, h, y)).join(' ')} L600 ${String(y)} V300 H0Z`;

function Illustration() {
  return (
    <div className="promise__art" aria-hidden="true">
      <svg className="promise__rosette" viewBox="0 0 120 120" fill="none" stroke="currentColor" strokeWidth="1.6">
        {[0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5].map((a) => (
          <ellipse key={a} cx="60" cy="60" rx="18" ry="44" transform={`rotate(${String(a)} 60 60)`} />
        ))}
        <circle cx="60" cy="60" r="7" fill="currentColor" stroke="none" />
      </svg>
      <svg className="promise__hills" viewBox="0 0 600 300" preserveAspectRatio="none">
        <defs>
          <linearGradient id="dome-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.75" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0.08" />
          </linearGradient>
        </defs>
        <path className="promise__hill promise__hill--3" d={skyline(190, [[90, 200, 70], [300, 300, 150], [510, 200, 70]])} />
        <path className="promise__hill promise__hill--2" d={skyline(235, [[60, 160, 50], [300, 240, 110], [540, 160, 50]])} />
        <path className="promise__hill promise__hill--1" d={skyline(280, [[150, 180, 50], [300, 160, 80], [450, 180, 50]])} />
      </svg>
    </div>
  );
}

export function HomePage() {
  return (
    <div className="home">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero__aurora" aria-hidden="true">
          <span className="hero__blob hero__blob--core" />
          <span className="hero__blob hero__blob--left" />
          <span className="hero__blob hero__blob--right" />
        </div>
        <div className="hero__inner">
          <p className="hero__eyebrow">
            <BrandMark size={18} />
            Fair registration for community programs
          </p>
          <h1 id="hero-title" className="hero__title">
            Registration is a lottery, not a race.
          </h1>
          <p className="hero__lede">
            Built on frozen inputs and public randomness. Siblings kept together, odds told honestly.
            <br className="hero__br" /> A draw that anyone can replay.
          </p>
          <div className="hero__actions">
            <ButtonLink to="/demo" size="lg">
              Try the judge demo
            </ButtonLink>
            <ButtonLink to="/programs" variant="secondary" size="lg">
              Explore programs
            </ButtonLink>
          </div>
          <p className="hero__note">
            No sign-up: one click gives you a private sandbox with synthetic families, a live drand-seeded draw and a replay.
          </p>
        </div>
      </section>

      <Marquee />

      <section className="home-section" aria-labelledby="platform-title">
        <h2 id="platform-title" className="display-1 center">
          The registration platform
          <br />
          communities can verify
        </h2>
        <Showcase />
      </section>

      <section className="home-section" aria-labelledby="fairness-title">
        <div className="section-head">
          <div>
            <h2 id="fairness-title" className="display-1">
              Fairness, built around families.
            </h2>
            <p className="section-head__lede">
              Even Odds replaces the 9:00 a.m. scramble for camps, swim lessons and garden plots with a transparent draw that keeps siblings together.
            </p>
          </div>
          <ButtonLink to="/programs" variant="secondary" size="lg">
            See open programs
          </ButtonLink>
        </div>
        <FairnessColumns />
      </section>

      <section className="home-section home-section--tint" aria-labelledby="verify-heading">
        <h2 id="verify-heading" className="visually-hidden">
          Verify a draw
        </h2>
        <VerifySection />
      </section>

      <section className="home-section" aria-labelledby="promise-title">
        <h2 id="promise-title" className="display-1 center">
          So every family gets an even chance
        </h2>
        <div className="promise">
          <Illustration />
          <div className="promise__list">
            <ul>
              {PROMISES.map(({ title, body }) => (
                <li key={title}>
                  <Sparkle size={22} strokeWidth={1.4} className="promise__star" aria-hidden="true" />
                  <div>
                    <h3>{title}</h3>
                    <p>{body}</p>
                  </div>
                </li>
              ))}
            </ul>
            <ButtonLink to="/signin" size="lg" block>
              Get started as a family
            </ButtonLink>
          </div>
        </div>
      </section>

      <section className="home-section" aria-labelledby="audience-title">
        <h2 id="audience-title" className="display-1 center">
          Built for everyone
          <br />
          around the draw
        </h2>
        <ul className="audiences">
          {AUDIENCES.map(({ icon: Icon, tone, title, body, to, cta }) => (
            <li key={title}>
              <Link to={to} className="audience" data-tone={tone}>
                <span className="audience__tile" aria-hidden="true">
                  <Icon size={28} strokeWidth={1.5} />
                </span>
                <span className="audience__text">
                  <span className="audience__title">{title}</span>
                  <span className="audience__body">{body}</span>
                  <span className="audience__cta">
                    {cta} <ArrowRight size={15} aria-hidden="true" />
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="home-section" aria-labelledby="cta-title">
        <div className="cta-band">
          <BrandMark className="cta-band__mark" size={44} />
          <h2 id="cta-title" className="display-1">
            Make registration day a non-event.
          </h2>
          <p>Open the window for a week. Draw once, in public. Sleep through 9:00 a.m.</p>
          <div className="cta-band__actions">
            <Link to="/programs" className="btn btn--lg cta-band__primary">
              Browse programs
            </Link>
            <Link to="/status" className="btn btn--lg cta-band__secondary">
              System status
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
