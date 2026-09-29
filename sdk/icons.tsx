import type {ReactNode} from "react";

const shapes: Record<string, ReactNode> = {
  pdf: <><path fill="#eaf3e5" stroke="#54873d" d="M4 2.5h11l5 5V21H4z"/><path stroke="#54873d" d="M15 3v5h5M7 11h7M7 14h5"/><path fill="#528d3c" stroke="#fff" d="M16 13h4v3h3v4h-3v3h-4v-3h-3v-4h3z"/></>,
  folder: <><path fill="#edcc7c" stroke="#a7863c" d="M2 5h8l2 3h10v12H2z"/><path fill="#f5da91" stroke="#a7863c" d="M2 10h21l-3 10H2z"/></>,
  save: <><path fill="#7199bd" stroke="#426a8d" d="M3 3h16l2 2v16H3z"/><path fill="#e8eef2" stroke="#426a8d" d="M7 3h9v6H7zM7 14h10v7H7z"/><path stroke="#426a8d" d="M14 4v4"/></>,
  book: <><path fill="#dbe7f3" stroke="#53799f" d="M4 3h16v18H6a2 2 0 0 1-2-2z"/><path stroke="#53799f" d="M7 3v14M4 18h16M10 7h7M10 10h7"/><path fill="#fff" stroke="#53799f" d="M6 18h14v3H6a1.5 1.5 0 0 1 0-3z"/></>,
  edit: <><path fill="#e4e1ef" stroke="#7e6e98" d="M3 5h13v16H3zM6 2h13v16"/><path fill="#e7bc61" stroke="#9c793c" d="m10 18 1-4L20 5l3 3-9 9z"/><path stroke="#9c793c" d="m18 7 3 3M10 18l4-1"/></>,
  export: <><path fill="#e6eddc" stroke="#6b8547" d="M3 3h11v18H5a2 2 0 0 1-2-2z"/><path stroke="#6b8547" d="M6 3v14M3 18h11"/><path fill="#e6ad50" stroke="#a5782f" d="M12 10h6V6l6 6-6 6v-4h-6z"/></>,
  plugin: <path fill="#d9b479" stroke="#98733a" d="M3 3h6v2a3 3 0 1 0 6 0V3h6v6h-2a3 3 0 1 0 0 6h2v6h-6v-2a3 3 0 1 0-6 0v2H3v-6h2a3 3 0 1 0 0-6H3z"/>,
  settings: <><path fill="#d0d5d9" stroke="#707b85" d="m9 2 6 0 1 4 4 1 2 5-3 3v4l-5 3-3-3-4 1-4-4 1-4-2-3 3-5z"/><circle fill="#f7f7f7" stroke="#707b85" cx="12" cy="12" r="4"/></>,
  list: <><path stroke="currentColor" d="M8 5h14M8 12h14M8 19h14"/><path fill="currentColor" stroke="none" d="M2 3h4v4H2zM2 10h4v4H2zM2 17h4v4H2z"/></>,
  grid: <path stroke="currentColor" d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>,
};

export function Icon({name}: {name: keyof typeof shapes}) {
  return <svg className="icon" width="24" height="24" viewBox="0 0 24 24" fill="none" strokeWidth="1.25" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg>;
}
