"use client";

import { useState, useTransition } from "react";
import { captureText, captureSignal } from "./actions";

export function CaptureBox() {
  const [text, setText] = useState("");
  const [signalContent, setSignalContent] = useState("");
  const [signalNote, setSignalNote] = useState("");
  const [msg, setMsg] = useState("");
  const [pending, startTransition] = useTransition();

  function submitText() {
    if (!text.trim()) return;
    setMsg("");
    startTransition(async () => {
      try {
        await captureText(text);
        setText("");
        setMsg("تم الالتقاط ✅");
      } catch (e) {
        setMsg("تعذّر الحفظ: " + (e instanceof Error ? e.message : "خطأ غير متوقّع"));
      }
    });
  }

  function submitSignal() {
    if (!signalContent.trim()) return;
    setMsg("");
    startTransition(async () => {
      try {
        await captureSignal(signalContent, signalNote);
        setSignalContent("");
        setSignalNote("");
        setMsg("تم حفظ الإشارة ✅");
      } catch (e) {
        setMsg("تعذّر الحفظ: " + (e instanceof Error ? e.message : "خطأ غير متوقّع"));
      }
    });
  }

  const inputCls =
    "w-full rounded-lg border border-foreground/15 bg-transparent px-3 py-2 outline-none focus:border-foreground/40";
  const btnCls =
    "rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50";

  return (
    <div className="space-y-6">
      {/* الالتقاط النصي السريع */}
      <div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="اكتب فكرتك هنا…"
          aria-label="نص الفكرة"
          rows={4}
          className={inputCls}
        />
        <div className="mt-2 flex justify-start">
          <button
            onClick={submitText}
            disabled={pending || !text.trim()}
            className={btnCls}
          >
            {pending ? "جارٍ…" : "التقط الفكرة"}
          </button>
        </div>
      </div>

      {/* حفظ إشارة */}
      <details className="rounded-xl border border-foreground/10 p-4">
        <summary className="cursor-pointer text-sm font-medium">
          حفظ إشارة (رابط أو اقتباس رأيته)
        </summary>
        <div className="mt-3 space-y-2">
          <input
            value={signalContent}
            onChange={(e) => setSignalContent(e.target.value)}
            placeholder="الرابط أو النص"
            aria-label="الرابط أو النص"
            className={inputCls}
          />
          <input
            value={signalNote}
            onChange={(e) => setSignalNote(e.target.value)}
            placeholder="لماذا حفظته؟ (اختياري)"
            aria-label="سبب حفظ الإشارة (اختياري)"
            className={inputCls}
          />
          <div className="flex justify-start">
            <button
              onClick={submitSignal}
              disabled={pending || !signalContent.trim()}
              className={btnCls}
            >
              حفظ الإشارة
            </button>
          </div>
        </div>
      </details>

      {msg && <p className="text-sm text-foreground/60">{msg}</p>}
    </div>
  );
}
