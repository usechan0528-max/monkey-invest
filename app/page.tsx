"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, ArrowUp, ArrowDown, ArrowRight, Check, ChevronDown, Clock3, LockKeyhole, RotateCcw, ShieldCheck, Sparkles, Users } from "lucide-react";

import MemberPanel from "@/components/member-panel";
import LeaderboardPanel from "@/components/leaderboard-panel";
import PrivacyNotice from "@/components/privacy-notice";
import {resultLabel as roundResult,openingDetails,decimalLabel} from "@/lib/poll/presentation.mjs";

type Choice = "up" | "down";
type Round = {
  id: string;
  market: string;
  symbol: string;
  name: string;
  opensAt: string;
  deadline: string;
  closesAt: string;
  revealAt?: string;
  status: "upcoming" | "open" | "locked" | "settled" | "void";
  myVote: Choice | null;
  hasVoted?: boolean;
  tally: null | { up: number; down: number; total: number };
  result: null | Record<string, unknown>;
  openingPrice?: null | {price:string;sourceLabel:string;sourceUrl:string;observedAt:string;asOf?:string;revision:number};
};
type AppState = {
  csrf: string | null;
  member: { username: string } | null;
  serverNow: string;
  mode: "prelaunch" | "live";
  proposal: { voteWindow: string; rulesConfirmed: boolean; resultVisibility?: string };
  score: { humans: number; chimp: number };
  rounds: Round[];
  storage: string;
};

function Instagram({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r=".8" fill="currentColor" stroke="none" /></svg>;
}

const instagram = "https://www.instagram.com/monkey_invest_korea/";
const marketNames: Record<string, string> = { KOSPI: "한국 시장", NASDAQ: "미국 시장" };

function dateLabel(value: string, market: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "일정 확인 중";
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: market.toUpperCase() === "NASDAQ" ? "America/New_York" : "Asia/Seoul", hour12: false }).format(date);
}

function countdown(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}일 ${Math.floor((seconds % 86400) / 3600)}시간`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function Home() {
  const [data, setData] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [market, setMarket] = useState("KOSPI");
  const [now, setNow] = useState(0);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [authRefreshing, setAuthRefreshing] = useState(false);
  const [memberEpoch, setMemberEpoch] = useState(0);
  const serverClock = useRef({ time: 0, received: 0 });
  const requestInFlight = useRef(false);
  const requestVersion = useRef(0);
  const memberVersion = useRef(0);

  const refresh = useCallback(async (force = false) => {
    if (requestInFlight.current && !force) return;
    const version = ++requestVersion.current;
    requestInFlight.current = true;
    try {
      const response = await fetch("/api/state", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("state_unavailable");
      const next = await response.json() as AppState;
      if (version !== requestVersion.current) return;
      if (!Array.isArray(next.rounds) || !next.score || !Number.isFinite(Date.parse(next.serverNow))) throw new Error("invalid_state");
      serverClock.current = { time: Date.parse(next.serverNow), received: Date.now() };
      setNow(serverClock.current.time);
      setData(next);
      setLoadError(false);
    } catch {
      if (version === requestVersion.current) setLoadError(true);
    } finally {
      if (version === requestVersion.current) requestInFlight.current = false;
    }
  }, []);

  const memberChanged = useCallback(async () => {
    memberVersion.current++;
    setMemberEpoch(value => value + 1);
    setAuthRefreshing(true);
    setChoice(null);
    setMessage("");
    setMessageError(false);
    setData(current => current ? { ...current, member: null, csrf: null, rounds: current.rounds.map(item => ({ ...item, myVote: null, hasVoted: false })) } : current);
    try { await refresh(true); } finally { setAuthRefreshing(false); }
  }, [refresh]);

  useEffect(() => { void refresh(); }, [refresh]);
  const hasActiveRounds = data?.rounds.some((round) => ["upcoming", "open", "locked"].includes(round.status)) ?? false;
  useEffect(() => {
    if (!hasActiveRounds) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, [hasActiveRounds, refresh]);
  useEffect(() => {
    if (!hasActiveRounds) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setNow(serverClock.current.time + Date.now() - serverClock.current.received);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasActiveRounds]);

  const matchingRounds = data?.rounds.filter((round) => round.market.toUpperCase() === market) ?? [];
  const round = matchingRounds.find((round) => ["open", "upcoming", "locked"].includes(round.status)) ?? matchingRounds[0];
  const isPrelaunch = !data || data.mode === "prelaunch";
  const deadlinePassed = !!round && now >= Date.parse(round.deadline);
  const canVote = !isPrelaunch && !!round && round.status === "open" && !deadlinePassed && now >= Date.parse(round.opensAt) && !round.myVote && !round.hasVoted && !loadError && !submitting && !authRefreshing;
  const opening = openingDetails(round);
  const visibleTally = round && deadlinePassed && (!round.revealAt || now >= Date.parse(round.revealAt)) ? round.tally : null;
  const history = data?.rounds.filter((round) => ["settled", "void"].includes(round.status)) ?? [];
  const activeChoice = round?.myVote ?? choice;
  const shownScore = (side: "humans" | "chimp") => data && !loadError ? String(data.score[side]).padStart(2, "0") : "—";

  function changeMarket(next: string) {
    setMarket(next);
    setChoice(null);
    setMessage("");
  }

  async function submitVote() {
    if (!canVote || !round || !choice) return;
    const version = memberVersion.current;
    setSubmitting(true);
    setMessage("");
    setMessageError(false);
    try {
      const response = await fetch("/api/vote", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", ...(data?.member && data?.csrf ? { "X-CSRF-Token": data.csrf } : {}) }, body: JSON.stringify({ roundId: round.id, choice }) });
      const result = await response.json() as { ok?: boolean; choice?: Choice; error?: string; code?: string };
      if (version !== memberVersion.current) return;
      if (!response.ok) {
        const errors: Record<number, string> = { 409: "이 브라우저에서는 이미 투표했어요. 기존 투표를 확인합니다.", 410: "투표가 마감됐어요. 다음 대결에서 함께해요.", 503: "지금은 투표를 저장할 수 없어요. 잠시 후 다시 시도해 주세요." };
        throw new Error(errors[response.status] ?? "투표를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
      }
      const savedChoice: Choice = result.choice === "down" ? "down" : "up";
      setData((current) => current ? { ...current, rounds: current.rounds.map((item) => item.id === round.id ? { ...item, myVote: savedChoice } : item) } : current);
      setMessage(`${savedChoice === "up" ? "상승" : "하락"}에 한 표! 투표가 저장됐어요. 공개 시간 이후 모두의 선택을 확인해 주세요.`);
    } catch (error) {
      if (version !== memberVersion.current) return;
      setMessageError(true);
      setMessage(error instanceof Error ? error.message : "연결이 끊겼어요. 투표 저장 여부를 확인한 후 다시 시도해 주세요.");
    } finally {
      setSubmitting(false);
      void refresh();
    }
  }

  return (
    <>
      <a href="#match" className="skip-link">투표 영역으로 바로가기</a>
      <header className="site-header">
        <div className="header-inner">
          <a href="#" className="brand" aria-label="침팬지와 대결하기 홈">
            <img src="/chimp-portrait.webp" width="40" height="40" alt="" />
            <span>침팬지와 대결하기<small>MONKEY INVEST KOREA</small></span>
          </a>
          <nav aria-label="주 메뉴">
            <a href="#match">오늘의 대결</a>
            <a href="#records">내 전적</a><a href="#leaderboard" className="rank-nav">전체 순위</a><a href="#rules">대결 방식</a>
            <a href={instagram} target="_blank" rel="noreferrer" className="header-instagram" aria-label="인스타그램 monkey_invest_korea, 새 창"><Instagram size={19} /><span>Instagram</span><ArrowUpRight size={15} /></a>
          </nav>
        </div>
      </header>

      <main>
        <section className="hero page-width" aria-labelledby="hero-title">
          <div className="hero-copy">
            <div className="eyebrow"><span className="small-star">✳</span> HUMAN INTUITION. MONKEY BUSINESS.</div>
            <h1 id="hero-title">침팬지를,<br /><span className="hero-lastline">이길 수 있을까<span className="serif-question">?</span></span></h1>
            <p className="hero-description">무작위로 고른 주식. 인간이 예측한 방향.<br />상승 또는 하락, 당신의 직감을 한 표로 보여주세요.</p>
            <div className="hero-actions"><a className="button button-primary" href="#match">대결에 참여하기 <ArrowDown size={17} /></a><span className="anonymous-label"><ShieldCheck size={16} /> 로그인 없이, 익명으로</span></div>
            <div className="hero-note"><span className="status-dot" /> {data?.mode === "live" ? "한 종목, 두 가지 선택. 함께 예측해요." : "첫 대결을 준비하고 있어요"}</div>
          </div>
          <div className="hero-visual">
            <div className="visual-topline"><span>THE CHALLENGER</span><span>01 / CHIMP</span></div>
            <img className="hero-chimp" src="/chimp-theater.webp" alt="붉은 극장 의자에 앉아 턱을 괴고 대결을 기다리는 침팬지" fetchPriority="high" width="900" height="708" />
            <div className="visual-label"><span>당신의 상대가<br />기다리고 있습니다.</span><span className="visual-arrow">↗</span></div>
            <div className="challenger-sticker" aria-hidden="true"><span>분석은 인간이</span><strong>승부는<br />시장에게.</strong><span>LET’S PLAY FAIR</span></div>
          </div>
        </section>

        <section className="score-strip page-width" aria-label="누적 대결 점수">
          <div className="score-intro"><span className="section-kicker">THE SCOREBOARD</span><h2>인간의 집단지성,<br />얼마나 통할까요?</h2></div>
          <div className="score-game">
            <div className="score-team human-team"><div className="team-icon"><Users size={21} /></div><div className="team-name">인간<small>HUMANS</small></div><strong className="score-number">{shownScore("humans")}</strong></div>
            <span className="score-vs">vs.</span>
            <div className="score-team chimp-team"><strong className="score-number">{shownScore("chimp")}</strong><div className="team-name">침팬지<small>CHIMP</small></div><img className="team-avatar" src="/chimp-portrait.webp" width="43" height="43" alt="" /></div>
          </div>
          <p className="score-caption">{loadError || !data ? "대결 정보를 확인하고 있어요." : history.length > 0 ? `${history.length}번의 대결, 계속되는 도전` : "아직 승부는 시작되지 않았어요."}<br /><span>{loadError || !data ? "연결 후 최신 점수가 표시됩니다." : history.length > 0 ? "판정이 완료된 대결 기준" : "첫 승리의 주인공은 누구일까요?"}</span></p>
        </section>

        <section id="match" className="match-section page-width" aria-labelledby="match-title">
          <div className="section-heading"><div><span className="section-kicker">PICK YOUR SIDE</span><h2 id="match-title">오늘의 대결</h2></div><span className="section-subtitle">복잡한 분석은 잠시 내려놓고, 한 표.</span></div>
          <div className="match-layout">
            <div className="poll-card">
              <div className="market-tabs" role="tablist" aria-label="대결 시장 선택">
                {["KOSPI", "NASDAQ"].map((name) => <button key={name} id={`tab-${name}`} type="button" role="tab" aria-selected={market === name} aria-controls="market-panel" className={market === name ? "market-tab selected" : "market-tab"} onClick={() => changeMarket(name)}><span className="market-emblem" aria-hidden="true">{name === "KOSPI" ? "KR" : "US"}</span><strong>{name}</strong><span className="market-name">{marketNames[name]}</span><span className="tab-dot" /></button>)}
              </div>
              <div id="market-panel" role="tabpanel" aria-labelledby={`tab-${market}`} className="poll-content">
                {loadError && <div className="connection-error" role="alert"><span>대결 정보를 불러오지 못했어요. 연결을 확인해 주세요.</span><button onClick={() => void refresh()} type="button"><RotateCcw size={14} /> 다시 시도</button></div>}
                <div className="poll-status-row"><span className="round-label">{round ? `${market} MATCH` : "THE FIRST MATCH"}</span><span className={`state-badge ${round?.status === "open" && !deadlinePassed ? "is-open" : ""}`}><span className="status-dot" />{!data && !loadError ? "정보 확인 중" : !round ? "첫 대결 준비 중" : round.myVote ? "투표 완료" : round.status === "upcoming" ? "시작 대기" : round.status === "open" && !deadlinePassed ? "투표 진행 중" : ["settled", "void"].includes(round.status) ? "대결 종료" : "투표 마감"}</span></div>
                {round ? <>
                  <div className="stock-heading"><span className="stock-symbol">{round.symbol}</span><h3>{round.name || round.symbol}</h3><p>{marketNames[market]} · {dateLabel(round.opensAt, market)} 개장 기준 <span>({market === "NASDAQ" ? "뉴욕" : "한국"} 시간)</span></p></div>
                  {round.status !== "upcoming" && <div className="opening-price" role="status"><strong>{opening ? `확인된 시가 ${decimalLabel(opening.price)} ${opening.currency}` : "시가 확인 중"}</strong>{opening ? <p>{opening.sessionDate} 정규장 · <a href={opening.sourceUrl} target="_blank" rel="noreferrer">{opening.sourceLabel}</a><br />자료 확인: {dateLabel(opening.observedAt, market)} ({market === "NASDAQ" ? "뉴욕" : "한국"} 시간). 제공자 가격이며 거래소 공식 경매 가격을 뜻하지 않습니다.</p> : <p>해당 거래일의 시가와 출처가 확인되면 표시합니다. 임의 가격은 넣지 않아요.</p>}{round.result?.status === "verified" && typeof round.result.close === "string" && <p>확인된 종가 {decimalLabel(round.result.close)} {market === "KOSPI" ? "KRW" : "USD"}</p>}</div>}
                  <div className="round-timing"><Clock3 size={16} /><span>{round.status === "upcoming" ? "투표 시작까지" : round.status === "open" && !deadlinePassed ? "투표 마감까지" : "투표 마감"}</span><strong>{round.status === "upcoming" ? countdown(Date.parse(round.opensAt) - now) : round.status === "open" && !deadlinePassed ? countdown(Date.parse(round.deadline) - now) : dateLabel(round.deadline, market)}</strong></div>
                </> : <div className="prelaunch-stock"><div className="ticket-icon" aria-hidden="true"><Sparkles size={25} /></div><h3>첫 종목, 곧 공개합니다.</h3><p>검증된 일정과 첫 종목을 준비 중이에요.<br />공식 시작 일정은 인스타그램에서 안내할게요.</p><span className="waiting-chip"><Clock3 size={13} /> 첫 대결 일정 미정</span></div>}
                <div className="prediction-question"><h4>{round ? "오늘 종가, 시가보다 높을까요?" : "당신의 선택은?"}</h4><span>{round?.myVote ? "저장된 나의 한 표" : "상승 또는 하락, 하나만 선택"}</span></div>
                <div className="vote-options" role="group" aria-label="주가 방향 선택">
                  <button type="button" aria-pressed={activeChoice === "up"} className={`vote-option up ${activeChoice === "up" ? "chosen" : ""}`} disabled={!canVote} onClick={() => setChoice("up")}><span className="direction-icon"><ArrowUp size={24} strokeWidth={1.7} /></span><span><strong>상승</strong><small>시가보다 높게</small></span>{activeChoice === "up" && <Check size={19} className="vote-check" />}</button>
                  <button type="button" aria-pressed={activeChoice === "down"} className={`vote-option down ${activeChoice === "down" ? "chosen" : ""}`} disabled={!canVote} onClick={() => setChoice("down")}><span className="direction-icon"><ArrowDown size={24} strokeWidth={1.7} /></span><span><strong>하락</strong><small>시가보다 낮게</small></span>{activeChoice === "down" && <Check size={19} className="vote-check" />}</button>
                </div>
                {round?.myVote ? <div className="saved-vote"><Check size={17} /> {round.myVote === "up" ? "상승" : "하락"}에 투표했어요. 변경할 수 없어요.</div> : <button className="submit-vote" type="button" disabled={!canVote || !choice} onClick={() => void submitVote()}>{submitting ? "한 표를 저장하고 있어요…" : canVote ? choice ? `${choice === "up" ? "상승" : "하락"}에 투표하기` : "방향을 선택해 주세요" : !round ? "대결이 열리면 투표할 수 있어요" : round.status === "upcoming" ? "개장 후 투표할 수 있어요" : "이번 투표는 마감됐어요"}{canVote ? <ArrowRight size={17} /> : <LockKeyhole size={15} />}</button>}
                <div className={`vote-feedback ${messageError ? "error" : ""}`} role="status" aria-live="polite" aria-atomic="true">{message}</div>
                {visibleTally ? <div className="tally"><div className="tally-heading"><strong>모두의 선택</strong><span>총 {visibleTally.total.toLocaleString()}표</span></div><div className="tally-track"><div style={{ width: `${visibleTally.total ? visibleTally.up / visibleTally.total * 100 : 50}%` }} /></div><div className="tally-labels"><span>상승 {visibleTally.up.toLocaleString()}표</span><span>하락 {visibleTally.down.toLocaleString()}표</span></div>{round && <p className="result-label" role="status">{roundResult(round)}</p>}</div> : <p className="poll-footnote"><LockKeyhole size={12} /> {data?.proposal.resultVisibility === "after_deadline" ? "투표 현황은 투표 마감 후 공개돼요." : "투표 현황은 장 마감 후 공개돼요."}{canVote && " 투표 후 변경은 불가해요."}</p>}
              </div>
            </div>
            <aside className="match-aside">
              <div className="editorial-note"><span className="note-kicker"><span>✳</span> A FAIR LITTLE GAME</span><h3>한 종목.<br />두 가지 선택.<br /><span>인간 vs. 침팬지.</span></h3><p>종목은 사전 집합에서 무작위.<br />인간의 방향 선택은 다수결.<br />오늘의 시장이 답을 알려줍니다.</p><div className="note-divider" /><div className="mini-rule"><span>01</span><p>시장이 열리면 종목 공개</p></div><div className="mini-rule"><span>02</span><p>상승 · 하락 익명 투표</p></div><div className="mini-rule"><span>03</span><p>장 마감 후 승부 확인</p></div><a href="#rules" className="text-link">자세한 대결 방식 <ArrowUpRight size={16} /></a></div>
              <a className="instagram-card" href={instagram} target="_blank" rel="noreferrer"><Instagram size={22} /><span><strong>첫 대결을 놓치지 마세요</strong><small>@monkey_invest_korea</small></span><ArrowUpRight size={19} /></a>
            </aside>
          </div>
        </section>

        <MemberPanel onChange={memberChanged} />
        <LeaderboardPanel key={memberEpoch} />

        <section id="rules" className="rules-section" aria-labelledby="rules-title"><div className="page-width">
          <div className="section-heading"><div><span className="section-kicker">HOW WE PLAY</span><h2 id="rules-title">대결은 이렇게 진행돼요</h2></div><span className="outline-chip">정규장 기준 · 실제 회차 준비 중</span></div>
          <ol className="rules-grid">
            <li><span className="rule-number">01</span><h3>무작위로 종목을 고르면</h3><p>시장별 사전 종목 집합에서 개장 전에 한 종목을 무작위 선정하고 추첨 기록을 고정해요. 종목은 정규장 시작에 공개합니다. 휴장·조기 폐장·서머타임은 거래소 일정으로 확인해요.</p><span className="rule-tag">KOSPI · NASDAQ</span></li>
            <li><span className="rule-number">02</span><h3>인간은 방향을 예측해요</h3><p>시가 대비 종가가 오를지, 내릴지 투표해요. 마감 시 더 많은 표를 받은 방향이 인간의 선택이 됩니다.</p><span className="rule-tag">개장부터 폐장 1시간 전까지</span></li>
            <li><span className="rule-number">03</span><h3>종가가 승부를 정합니다</h3><p>인간의 다수결 예측이 맞으면 인간 +1, 틀리면 침팬지 +1. 출처를 확인한 정규장 시가·종가로 판정해요.</p><span className="rule-tag">매 대결, 새로운 한 점</span></li>
          </ol>
          <div className="rules-disclaimer"><span className="info-marker">i</span><p>운영 규칙: 정규장 개장부터 폐장 1시간 전까지 투표하며 집계는 장 마감 후 공개합니다. 일반일 코스피는 서울 09:00~14:30, 나스닥은 뉴욕 09:30~15:00입니다. 동률·무투표·시가와 종가가 같은 보합은 양쪽 모두 0점입니다. 가격 미검증은 판정을 보류하고 점수를 부여하지 않습니다. 침팬지는 별도 방향을 추첨하지 않습니다.</p></div>
          <p className="universe-policy">종목 집합: KOSPI는 KIND 상장회사 대표 종목 코드, NASDAQ은 직접 상장 보통주 등 일반 지분입니다. REIT·BDC 보통주는 포함하고 ETF·ADR·LP 지분 등은 제외합니다. 전체 상장 증권과 같은 범위는 아니며, 회차별 목록·추첨 증거와 가격 출처를 확인해 운영합니다.</p>
        </div></section>

        <section className="history-section page-width" aria-labelledby="history-title"><div className="section-heading"><div><span className="section-kicker">THE MATCH JOURNAL</span><h2 id="history-title">지난 대결</h2></div><span className="history-count">{data && !loadError ? history.length : "—"} MATCHES</span></div>
          {history.length ? <div className="history-list">{history.slice(0, 8).map((item) => <div className="history-row" key={item.id}><span className="history-market">{item.market.toUpperCase()}</span><div><strong>{item.name || item.symbol}</strong><small>{dateLabel(item.opensAt, item.market)} · {item.market.toUpperCase() === "NASDAQ" ? "뉴욕" : "한국"} 시간</small></div><span className="history-result">{roundResult(item)}</span></div>)}</div> : <div className="history-empty"><div className="history-empty-mark" aria-hidden="true">{data && !loadError ? "0" : "–"}<span>–</span>{data && !loadError ? "0" : "–"}</div><div><h3>{data && !loadError ? "아직 쓰이지 않은 승부 기록." : "대결 기록을 확인하고 있어요."}</h3><p>{data && !loadError ? <>첫 대결이 끝나면 이곳에 결과가 쌓여요.<br className="mobile-only" /> 첫 페이지를 함께 만들어 주세요.</> : "연결 후 최신 기록을 보여드릴게요."}</p></div><span className="empty-arrow" aria-hidden="true">↗</span></div>}
        </section>

        <section id="privacy" className="privacy-section page-width"><details open={privacyOpen} onToggle={(event) => setPrivacyOpen(event.currentTarget.open)}><summary><span><ShieldCheck size={18} /> 익명 투표와 회원정보 수집·보관·삭제 안내</span><ChevronDown size={17} /></summary><div className="privacy-copy"><PrivacyNotice /></div></details></section>
      </main>

      <footer className="site-footer page-width"><div className="footer-top"><a className="footer-brand" href="#">침팬지와 대결하기<span>MONKEY INVEST KOREA</span></a><a href={instagram} target="_blank" rel="noreferrer"><Instagram size={15} /> @monkey_invest_korea <ArrowUpRight size={14} /></a></div><div className="footer-bottom"><p>재미로 함께하는 시장 예측 실험입니다. 투자 권유나 투자 조언이 아니며, 실제 투자 판단의 근거로 사용하지 마세요.</p><span>HUMANS THINK. CHIMPS PICK.</span></div></footer>
    </>
  );
}
