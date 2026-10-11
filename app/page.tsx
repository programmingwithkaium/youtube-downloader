"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const API = (
  process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000"
).replace(/\/$/, "");

type Info = { title: string; thumbnail?: string | null; duration?: number | null; platform: string };
type Job = { status: string; progress: number; message: string };
type Item = { id: string; title: string; url: string; mode: "video" | "mp3"; quality: string; status: string; progress: number; createdAt: string };
type WritableLike = { write: (blob: Blob) => Promise<void>; close: () => Promise<void> };
type FolderLike = { getFileHandle: (name: string, options: { create: boolean }) => Promise<{ createWritable: () => Promise<WritableLike> }> };

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const p: Record<string, React.ReactNode> = {
    play: <path d="m8 5 12 7-12 7V5Z" />,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5M12 15V3" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.07 0l3-3A5 5 0 0 0 13 2.93l-1.72 1.72" /><path d="M14 11a5 5 0 0 0-7.07 0l-3 3A5 5 0 0 0 11 21.07l1.72-1.72" /></>,
    folder: <><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    trash: <><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6" /></>,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p[name] || <circle cx="12" cy="12" r="9" />}</svg>;
}
const progressOf = (n?: number) => typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
const completed = (s: string) => s === "complete" || s === "completed";
const terminal = (s: string) => completed(s) || s === "error";
const statusText = (s: string) => ({ queued: "প্রস্তুত হচ্ছে", downloading: "ডাউনলোড হচ্ছে", complete: "সম্পন্ন", completed: "সম্পন্ন", error: "ব্যর্থ" } as Record<string, string>)[s] || s || "অপেক্ষমাণ";
const durationText = (n?: number | null) => {
  if (n == null || !Number.isFinite(n)) return "সময় অজানা";
  const s = Math.floor(Math.max(0, n)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

export default function Home() {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"video" | "mp3">("video");
  const [quality, setQuality] = useState("720p");
  const [info, setInfo] = useState<Info | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [jobId, setJobId] = useState("");
  const [downloadMode, setDownloadMode] = useState<"video" | "mp3">("video");
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<Item[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [folder, setFolder] = useState<FolderLike | null>(null);
  const [folderMessage, setFolderMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("downloader-history");
      if (raw) {
        const data: unknown = JSON.parse(raw);
        if (Array.isArray(data)) setHistory(data.filter((x): x is Item => x && typeof x.id === "string" && typeof x.title === "string" && typeof x.url === "string" && (x.mode === "video" || x.mode === "mp3") && typeof x.createdAt === "string").slice(0, 50));
      }
    } catch { console.error("Could not load history"); }
    finally { setHistoryLoaded(true); }
  }, []);
  useEffect(() => { if (historyLoaded) { try { localStorage.setItem("downloader-history", JSON.stringify(history.slice(0, 50))); } catch { console.error("Could not save history"); } } }, [history, historyLoaded]);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const read = useCallback(async (r: Response) => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : `অনুরোধ ব্যর্থ (${r.status})`);
    return d;
  }, []);
  const updateHistory = useCallback((id: string, data: Job) => setHistory(prev => prev.map(x => x.id === id ? { ...x, status: data.status, progress: progressOf(data.progress) } : x)), []);

  async function getInfo() {
    setError(""); setInfo(null);
    if (!url.trim()) { setError("প্রথমে ভিডিওর লিংক দিন।"); return; }
    setLoadingInfo(true);
    try {
      const r = await fetch(`${API}/api/info`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: url.trim() }) });
      const d = await read(r) as Info;
      if (!d.title) throw new Error("ভিডিওর তথ্য পাওয়া যায়নি।");
      setInfo(d);
    } catch (e) { setError(e instanceof Error ? e.message : "ভিডিওর তথ্য আনা যায়নি।"); }
    finally { setLoadingInfo(false); }
  }

  async function startDownload() {
    setError("");
    if (!url.trim()) { setError("প্রথমে ভিডিওর লিংক দিন।"); return; }
    if (starting || loadingInfo) return;
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    setJob(null); setJobId(""); setStarting(true);
    try {
      const r = await fetch(`${API}/api/download`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: url.trim(), mode, quality: mode === "mp3" ? "Best available" : quality }) });
      const d = await read(r);
      if (typeof d.job_id !== "string") throw new Error("সার্ভার থেকে Job ID পাওয়া যায়নি।");
      const id = d.job_id as string;
      setDownloadMode(mode);
      const item: Item = { id, title: info?.title || url.trim(), url: url.trim(), mode, quality: mode === "mp3" ? "MP3" : quality, status: "queued", progress: 0, createdAt: new Date().toISOString() };
      setHistory(prev => [item, ...prev.filter(x => x.id !== id)].slice(0, 50));
      setJobId(id); setJob({ status: "queued", progress: 0, message: "ডাউনলোড প্রস্তুত হচ্ছে..." });
    } catch (e) { setError(e instanceof Error ? e.message : "ডাউনলোড শুরু করা যায়নি।"); }
    finally { setStarting(false); }
  }

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false, polling = false;
    async function poll() {
      if (cancelled || polling) return;
      polling = true;
      try {
        const r = await fetch(`${API}/api/status/${encodeURIComponent(jobId)}`);
        const d = await read(r) as Job;
        if (cancelled) return;
        const next = { ...d, progress: progressOf(d.progress), message: d.message || statusText(d.status) };
        setJob(next); updateHistory(jobId, next);
        if (terminal(next.status) && timer.current) { clearInterval(timer.current); timer.current = null; }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? `ডাউনলোডের অবস্থা দেখা যায়নি: ${e.message}` : "ডাউনলোডের অবস্থা দেখা যায়নি।");
      } finally { polling = false; }
    }
    void poll(); timer.current = setInterval(() => void poll(), 2500);
    return () => { cancelled = true; if (timer.current) { clearInterval(timer.current); timer.current = null; } };
  }, [jobId, read, updateHistory]);

  async function chooseFolder() {
    try {
      const picker = (window as unknown as { showDirectoryPicker?: () => Promise<FolderLike> }).showDirectoryPicker;
      if (!picker) { setFolderMessage("এই ব্রাউজারে Folder Select সমর্থিত নয়। Chrome ব্যবহার করুন।"); return; }
      setFolder(await picker()); setFolderMessage("ফোল্ডার নির্বাচন করা হয়েছে।");
    } catch (e) { if (e instanceof Error && e.name !== "AbortError") setFolderMessage("ফোল্ডার নির্বাচন করা যায়নি।"); }
  }
  async function saveToFolder() {
    if (!jobId || !folder || saving) return;
    setSaving(true); setFolderMessage("");
    try {
      const r = await fetch(`${API}/api/file/${encodeURIComponent(jobId)}`);
      if (!r.ok) throw new Error("সার্ভার থেকে ফাইল আনা যায়নি।");
      const blob = await r.blob();
      const ext = downloadMode === "mp3" ? "mp3" : "mp4";
      const name = (info?.title || "downloader-file").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim().slice(0, 100) || "downloader-file";
      const handle = await folder.getFileHandle(`${name}.${ext}`, { create: true });
      const writer = await handle.createWritable(); await writer.write(blob); await writer.close();
      setFolderMessage("ফাইল নির্বাচিত ফোল্ডারে সেভ হয়েছে!");
    } catch (e) { setFolderMessage(e instanceof Error ? e.message : "ফাইল সেভ করা যায়নি।"); }
    finally { setSaving(false); }
  }
  function clearHistory() { if (window.confirm("সব ডাউনলোড History মুছে ফেলতে চান?")) setHistory([]); }

  const busy = loadingInfo || starting || job?.status === "queued" || job?.status === "downloading";
  const qualityOptions = [{ value: "Best available", label: "সর্বোচ্চ উপলভ্য" }, { value: "1080p", label: "1080p Full HD" }, { value: "720p", label: "720p HD" }, { value: "480p", label: "480p" }, { value: "360p", label: "360p" }];

  return <main className="min-h-screen bg-[#f3f6ff] px-4 py-6 text-slate-900 sm:px-6 lg:px-8">
    <div className="pointer-events-none fixed inset-0 -z-0 overflow-hidden"><div className="absolute -left-24 -top-24 h-80 w-80 rounded-full bg-blue-200/40 blur-3xl" /><div className="absolute -right-20 top-24 h-80 w-80 rounded-full bg-violet-200/40 blur-3xl" /></div>
    <div className="relative mx-auto max-w-6xl">
      <header className="mb-8 flex items-center justify-between gap-3 rounded-2xl border border-white bg-white/90 px-4 py-3 shadow-sm backdrop-blur sm:px-6">
        <a href="#home" className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 text-white shadow-lg shadow-indigo-200"><Icon name="play" size={23} /></span><span><span className="block text-base font-extrabold sm:text-lg">Downloader<span className="text-indigo-600">Pro</span></span><span className="block text-[11px] text-slate-500">Your media, your choice.</span></span></a>
        <nav className="hidden gap-6 text-sm font-semibold text-slate-500 md:flex"><a href="#downloader" className="hover:text-indigo-600">Downloader</a><a href="#history" className="hover:text-indigo-600">History</a></nav>
        <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Ready</span>
      </header>

      <section id="home" className="mx-auto mb-8 max-w-3xl text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-white px-4 py-2 text-xs font-bold tracking-wide text-indigo-700 shadow-sm"><Icon name="shield" size={15} /> SIMPLE · FAST · EASY TO USE</span>
        <h1 className="mt-5 whitespace-nowrap text-[clamp(1.3rem,4.2vw,3.5rem)] font-black tracking-tight text-slate-950">Your media, <span className="bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 bg-clip-text text-transparent">your choice.</span></h1>
        <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-slate-500 sm:text-base">ভিডিওর লিংক দিন, প্রিভিউ দেখুন এবং পছন্দের ফরম্যাট ও কোয়ালিটিতে ডাউনলোড করুন।</p>
        <div className="mt-5 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs font-semibold text-slate-500"><span className="inline-flex items-center gap-1"><Icon name="check" size={15} /> MP4 Video</span><span className="inline-flex items-center gap-1"><Icon name="check" size={15} /> MP3 Audio</span><span className="inline-flex items-center gap-1"><Icon name="check" size={15} /> Quality Options</span></div>
      </section>

      <section id="downloader" className="overflow-hidden rounded-[28px] border border-white bg-white shadow-[0_28px_90px_rgba(55,75,130,0.13)]">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-5 sm:px-8"><div className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-50 text-blue-600"><Icon name="download" size={22} /></span><div><h2 className="text-lg font-extrabold sm:text-xl">ভিডিও ডাউনলোডার</h2><p className="mt-1 text-xs text-slate-500 sm:text-sm">আপনার অনুমোদিত ভিডিও বা অডিওর লিংক দিন</p></div></div><span className="hidden rounded-full bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-700 sm:inline-flex">MP4 / MP3</span></div>

        <div className="space-y-7 p-5 sm:p-8 lg:p-10">
          <div><label htmlFor="video-url" className="mb-2 block text-sm font-bold text-slate-700">ভিডিওর লিংক</label><div className="flex flex-col gap-3 sm:flex-row"><div className="flex min-w-0 flex-1 items-center gap-3 rounded-full border border-slate-200 bg-slate-50 px-5 transition focus-within:border-blue-400 focus-within:bg-white focus-within:ring-4 focus-within:ring-blue-50"><span className="shrink-0 text-blue-500"><Icon name="link" size={20} /></span><input id="video-url" type="url" inputMode="url" autoComplete="url" value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !busy) void getInfo(); }} placeholder="https://www.youtube.com/watch?v=..." className="min-w-0 flex-1 bg-transparent py-4 text-sm outline-none placeholder:text-slate-400" />{url && <button type="button" aria-label="লিংক মুছুন" onClick={() => { setUrl(""); setInfo(null); setError(""); }} className="text-xl text-slate-400">×</button>}</div><button type="button" onClick={getInfo} disabled={loadingInfo || starting} className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-6 py-3.5 text-sm font-bold text-slate-700 shadow-sm transition hover:border-blue-200 hover:bg-blue-50 disabled:opacity-50">{loadingInfo ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" /> : <Icon name="file" size={17} />}{loadingInfo ? "তথ্য আনা হচ্ছে..." : "তথ্য দেখুন"}</button></div><p className="mt-2 pl-2 text-xs leading-5 text-slate-400">শুধু নিজের তৈরি অথবা ডাউনলোডের অনুমতি আছে এমন কনটেন্ট ব্যবহার করুন।</p></div>

          {info && <div className="grid gap-5 rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50/80 to-violet-50/60 p-4 sm:grid-cols-[minmax(0,1.1fr)_minmax(240px,.9fr)] sm:p-5"><div className="relative overflow-hidden rounded-2xl bg-slate-200 shadow-inner">{info.thumbnail ? <img src={info.thumbnail} alt="ভিডিওর থাম্বনেইল" className="aspect-video h-full min-h-40 w-full object-cover" /> : <div className="flex aspect-video min-h-40 items-center justify-center bg-gradient-to-br from-blue-100 to-indigo-200 text-blue-600"><span className="flex h-16 w-16 items-center justify-center rounded-full bg-white shadow-lg"><Icon name="play" size={30} /></span></div>}{info.duration != null && <span className="absolute bottom-3 left-3 rounded-full bg-slate-950/85 px-3 py-1.5 text-xs font-semibold text-white">{durationText(info.duration)}</span>}</div><div className="flex min-w-0 flex-col justify-center"><div className="mb-3 flex flex-wrap items-center gap-2"><span className="rounded-full bg-blue-100 px-3 py-1 text-[11px] font-extrabold uppercase text-blue-700">{info.platform || "Video"}</span><span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700"><Icon name="check" size={14} /> তথ্য পাওয়া গেছে</span></div><h3 className="break-words text-base font-extrabold leading-7 sm:text-lg">{info.title}</h3><p className="mt-2 text-sm leading-6 text-slate-500">নিচে প্রয়োজনীয় ফরম্যাট ও কোয়ালিটি নির্বাচন করুন।</p></div></div>}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(280px,.9fr)]">
            <div className="space-y-4"><h3 className="flex items-center gap-2 font-extrabold text-slate-800"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600"><Icon name="folder" size={17} /></span> সেভ করার ফোল্ডার</h3><div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-5"><div className="flex items-center gap-3"><span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white text-indigo-600 shadow-sm ring-1 ring-slate-200"><Icon name="folder" size={24} /></span><div className="min-w-0"><p className="break-words text-sm font-bold text-slate-800">{folder ? "ফোল্ডার নির্বাচন করা হয়েছে" : "কম্পিউটারের ফোল্ডার বেছে নিন"}</p><p className="mt-1 text-xs leading-5 text-slate-500">ডাউনলোড শেষ হলে এখানে ফাইল সেভ করতে পারবেন।</p></div></div><button type="button" onClick={chooseFolder} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-white px-4 py-3 text-sm font-bold text-indigo-700 transition hover:bg-indigo-50"><Icon name="folder" size={18} /> {folder ? "ফোল্ডার পরিবর্তন" : "Folder Select"}</button>{folderMessage && <p role="status" className="mt-3 break-words text-xs leading-5 text-slate-600">{folderMessage}</p>}</div><div className="rounded-2xl border border-slate-200 bg-white p-4"><label htmlFor="download-type" className="mb-2 block text-sm font-bold text-slate-700">ডাউনলোডের ধরন</label><select id="download-type" value={mode} onChange={e => setMode(e.target.value as "video" | "mp3")} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-sm font-semibold outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50"><option value="video">ভিডিও — MP4</option><option value="mp3">অডিও — MP3</option></select></div></div>
            <div className="space-y-4 rounded-2xl border border-blue-100 bg-gradient-to-b from-blue-50/70 to-white p-4 sm:p-5"><div><h3 className="font-extrabold text-slate-800">ভিডিওর কোয়ালিটি</h3><p className="mt-1 text-xs leading-5 text-slate-500">আপনার প্রয়োজন অনুযায়ী নির্বাচন করুন।</p></div><div className="grid grid-cols-2 gap-2 sm:grid-cols-1">{qualityOptions.map(o => <button key={o.value} type="button" disabled={mode === "mp3"} onClick={() => setQuality(o.value)} className={`flex min-w-0 items-center justify-between gap-2 rounded-xl border px-3 py-3 text-left text-sm font-semibold transition sm:px-4 ${quality === o.value ? "border-blue-500 bg-white text-blue-700 ring-2 ring-blue-100" : "border-slate-200 bg-white/80 text-slate-600 hover:border-blue-200"} disabled:cursor-not-allowed disabled:opacity-40`}><span className="truncate">{o.label}</span><span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${quality === o.value ? "border-blue-600 bg-blue-600" : "border-slate-300"}`}>{quality === o.value && <span className="h-1.5 w-1.5 rounded-full bg-white" />}</span></button>)}</div>{mode === "mp3" && <p className="text-xs text-slate-500">MP3 নির্বাচন করলে ভিডিও কোয়ালিটি প্রযোজ্য নয়।</p>}<div className="rounded-xl border border-slate-200 bg-white p-4"><div className="mb-2 flex items-center justify-between gap-3"><span className="text-xs font-bold text-slate-600">ডাউনলোডের অগ্রগতি</span><span className={`text-xs font-extrabold ${job && completed(job.status) ? "text-emerald-600" : "text-blue-600"}`}>{job ? progressOf(job.progress) : 0}%</span></div><div className="h-2.5 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full transition-all duration-500 ${job && completed(job.status) ? "bg-emerald-500" : job?.status === "error" ? "bg-red-500" : "bg-gradient-to-r from-blue-600 to-violet-600"}`} style={{ width: `${job ? progressOf(job.progress) : 0}%` }} /></div><p className="mt-2 text-xs leading-5 text-slate-500">{job ? job.message : "ডাউনলোড শুরু করলে অগ্রগতি এখানে দেখা যাবে।"}</p></div></div>
          </div>

          <button type="button" onClick={startDownload} disabled={busy} className="flex w-full items-center justify-center gap-2.5 rounded-2xl bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 px-5 py-4 text-sm font-extrabold text-white shadow-lg shadow-indigo-200/70 transition hover:-translate-y-0.5 hover:shadow-xl disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50">{starting || job?.status === "queued" || job?.status === "downloading" ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="download" size={20} />}{starting ? "ডাউনলোড শুরু হচ্ছে..." : job?.status === "downloading" || job?.status === "queued" ? "ডাউনলোড চলছে..." : "ডাউনলোড শুরু করুন"}</button>

          {job && <div className={`rounded-2xl border p-4 sm:p-5 ${job.status === "error" ? "border-red-200 bg-red-50" : completed(job.status) ? "border-emerald-200 bg-emerald-50/70" : "border-blue-100 bg-blue-50/60"}`}><div className="flex items-start gap-3"><span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${job.status === "error" ? "bg-red-100 text-red-600" : completed(job.status) ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700"}`}><Icon name={job.status === "error" ? "file" : completed(job.status) ? "check" : "download"} size={20} /></span><div className="min-w-0 flex-1"><p className="font-extrabold text-slate-800">{job.status === "error" ? "ডাউনলোড সম্পন্ন করা যায়নি" : completed(job.status) ? "ডাউনলোড সম্পন্ন হয়েছে!" : "ডাউনলোড চলছে"}</p><p className="mt-1 break-words text-sm leading-6 text-slate-600">{job.message}</p><p className="mt-1 text-xs font-semibold text-slate-500">স্ট্যাটাস: {statusText(job.status)}</p></div></div>{completed(job.status) && <div className="mt-4 grid gap-3 sm:grid-cols-2"><a href={`${API}/api/file/${encodeURIComponent(jobId)}`} download className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50"><Icon name="download" size={18} /> সাধারণভাবে ডাউনলোড</a><button type="button" onClick={saveToFolder} disabled={!folder || saving} className="flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"><Icon name="folder" size={18} /> {saving ? "ফাইল সেভ হচ্ছে..." : "নির্বাচিত ফোল্ডারে সেভ"}</button></div>}</div>}
          {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700"><p className="font-bold">একটি সমস্যা হয়েছে</p><p className="mt-1 break-words">{error}</p></div>}
          <div className="flex items-start gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-4"><span className="mt-0.5 shrink-0 text-emerald-600"><Icon name="shield" size={19} /></span><p className="text-xs leading-6 text-slate-500"><strong className="text-slate-700">ব্যবহারের নোট:</strong> Python API চালু থাকতে হবে। কিছু প্ল্যাটফর্মের সীমাবদ্ধতা, লগইন বা ফরম্যাটের কারণে ডাউনলোড নাও হতে পারে। অনুমতি ছাড়া কনটেন্ট ডাউনলোড করবেন না।</p></div>
        </div>
      </section>

      <section className="grid gap-4 py-7 sm:grid-cols-3">{[{ icon: "download", title: "সহজ ডাউনলোড", desc: "ভিডিও ও অডিওর জন্য সহজ নিয়ন্ত্রণ।" }, { icon: "clock", title: "লাইভ অগ্রগতি", desc: "স্ট্যাটাস ও প্রগ্রেস এক জায়গায় দেখুন।" }, { icon: "shield", title: "পরিষ্কার অভিজ্ঞতা", desc: "Responsive ডিজাইন ও স্পষ্ট বার্তা।" }].map(x => <div key={x.title} className="rounded-2xl border border-white bg-white/90 p-5 shadow-sm transition hover:-translate-y-1 hover:shadow-md"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-blue-50 to-violet-100 text-indigo-600"><Icon name={x.icon} size={21} /></span><h3 className="mt-4 font-extrabold">{x.title}</h3><p className="mt-2 text-sm leading-6 text-slate-500">{x.desc}</p></div>)}</section>

      <section id="history" className="overflow-hidden rounded-3xl border border-white bg-white shadow-[0_16px_55px_rgba(55,75,130,0.08)]"><div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-5 py-5 sm:px-7"><div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-violet-600"><Icon name="clock" size={21} /></span><div><h2 className="font-extrabold sm:text-lg">Download History</h2><p className="mt-1 text-xs text-slate-500">আপনার সাম্প্রতিক ডাউনলোডের তালিকা</p></div></div><button type="button" onClick={clearHistory} disabled={!history.length} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"><Icon name="trash" size={15} /> Clear History</button></div><div className="p-4 sm:p-6">{!historyLoaded ? <p className="py-10 text-center text-sm text-slate-400">History লোড হচ্ছে...</p> : !history.length ? <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-5 py-10 text-center"><span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-slate-400 shadow-sm"><Icon name="file" size={26} /></span><h3 className="mt-4 font-bold text-slate-700">এখনো কোনো ডাউনলোড নেই</h3><p className="mt-2 text-sm text-slate-500">প্রথম ডাউনলোড করলে সেটি এখানে দেখা যাবে।</p><a href="#downloader" className="mt-4 inline-flex items-center gap-2 text-sm font-bold text-indigo-600">Downloader-এ যান <Icon name="play" size={15} /></a></div> : <div className="space-y-3">{history.map(item => <div key={item.id} className="rounded-2xl border border-slate-100 p-4 transition hover:border-indigo-100 hover:bg-slate-50/60 sm:p-5"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div className="flex min-w-0 gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600"><Icon name={item.mode === "mp3" ? "file" : "play"} size={19} /></span><div className="min-w-0"><h3 className="break-words text-sm font-bold leading-6">{item.title}</h3><p className="mt-1 text-xs text-slate-500">{item.mode === "mp3" ? "MP3 Audio" : `MP4 Video · ${item.quality}`}</p><p className="mt-1 text-xs text-slate-400">{new Date(item.createdAt).toLocaleString()}</p></div></div><span className={`self-start rounded-full px-3 py-1.5 text-xs font-bold ${completed(item.status) ? "bg-emerald-50 text-emerald-700" : item.status === "error" ? "bg-red-50 text-red-700" : "bg-indigo-50 text-indigo-700"}`}>{statusText(item.status)}</span></div><div className="mt-4 flex items-center gap-3"><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${completed(item.status) ? "bg-emerald-500" : item.status === "error" ? "bg-red-400" : "bg-indigo-500"}`} style={{ width: `${progressOf(item.progress)}%` }} /></div><span className="w-10 text-right text-xs font-bold text-slate-500">{progressOf(item.progress)}%</span></div>{completed(item.status) && <a href={`${API}/api/file/${encodeURIComponent(item.id)}`} download className="mt-3 inline-flex items-center gap-2 text-xs font-bold text-indigo-600"><Icon name="download" size={15} /> ফাইল ডাউনলোড করুন</a>}</div>)}</div>}<p className="mt-4 text-xs leading-5 text-slate-400">History এই ব্রাউজারে সংরক্ষিত থাকে। সার্ভার থেকে ফাইল মুছে গেলে পুরোনো লিংক কাজ নাও করতে পারে।</p></div></section>

      <footer className="flex flex-col items-center justify-between gap-3 py-8 text-center text-xs text-slate-400 sm:flex-row"><p>© {new Date().getFullYear()} Downloader Pro. All rights reserved.</p><p className="flex items-center gap-1.5"><Icon name="shield" size={14} /> Use responsibly</p></footer>
    </div>
  </main>;
}
