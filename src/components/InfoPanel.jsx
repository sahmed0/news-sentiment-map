// src/components/InfoPanel.jsx
import { motion, AnimatePresence, useDragControls } from "framer-motion";
import { useIsMobile } from "../hooks/useMediaQuery";
import { X } from 'lucide-react';
import { Logo } from '@kiwicarbon/assets';

export function InfoPanel({ open, onClose }) {
  const isMobile = useIsMobile();
  const dragControls = useDragControls();

  const motionProps = isMobile
    ? {
        initial: { y: "100%", opacity: 0 },
        animate: { y: 0, opacity: 1 },
        exit: { y: "100%", opacity: 0 },
        drag: "y",
        dragListener: false,
        dragControls,
        dragConstraints: { top: 0, bottom: 0 },
        dragElastic: { top: 0, bottom: 0.6 },
        onDragEnd: (_, info) => {
          if (info.offset.y > 120 || info.velocity.y > 500) onClose();
        },
      }
    : {
        initial: { x: "100%", opacity: 0 },
        animate: { x: 0, opacity: 1 },
        exit: { x: "100%", opacity: 0 },
      };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="info-panel"
          {...motionProps}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className={`absolute z-20 flex flex-col ${
            isMobile
              ? "inset-x-0 bottom-0 h-[85dvh] max-h-[85dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
              : "top-0 right-0 h-full w-80"
          }`}
          style={{
            background: "rgb(var(--panel-rgb) / 0.85)",
            backdropFilter: "blur(16px)",
            border: "1px solid rgb(var(--fg-rgb) / 0.08)",
            ...(isMobile ? {} : { borderWidth: "0 0 0 1px" }),
          }}
        >
          {/* Mobile grab handle */}
          <div
            className="md:hidden flex justify-center pt-3 pb-2 shrink-0 cursor-grab active:cursor-grabbing touch-none"
            onPointerDown={(e) => dragControls.start(e)}
          >
            <div className="h-1 w-10 rounded-full bg-fg/25" />
          </div>

          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-3 sm:pt-5 pb-3 border-b border-fg/8 shrink-0">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest  mb-0.5">
                About
              </p>
              <h2 className="text-lg sm:text-2xl font-black tracking-tight truncate"
              style={{ fontFamily: "'DM Serif Display', serif", letterSpacing: "-0.02em" }}
              >
                World News Sentiment
              </h2>
            </div>
            <button
              onClick={onClose}
              className="w-9 h-9 shrink-0 flex items-center justify-center text-gray-400 hover:opacity-70 transition-opacity"
              aria-label="Close panel"
            >
              <X />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6 text-sm leading-relaxed text-fg/80 light:text-black/75">
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-widest mb-2">
                Data pipeline
              </h3>
              <p>
                Up to 5 of the most popular news headlines are fetched per country. High priority
                countries use{" "}
                <a
                  href="https://gnews.io"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-fg/95 light:text-black underline underline-offset-2 hover:opacity-70 transition-opacity"
                >
                  GNews
                </a>
                {" "}(which ranks stories by popularity), while the remaining countries use{" "}
                <a
                  href="https://newsdata.io"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-fg/95 light:text-black underline underline-offset-2 hover:opacity-70 transition-opacity"
                >
                  NewsData.io
                </a>
                {" "}for broader global coverage. Non-English headlines are translated via{" "}
                <a
                  href="https://azure.microsoft.com/en-us/services/cognitive-services/translator/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-fg/95 light:text-black underline underline-offset-2 hover:opacity-70 transition-opacity"
                >
                  Microsoft Azure Translator
                </a>
                {" "} before scoring. Scoring is done by a fine-tuned sentiment model. Results are fetched around 6 A.M. ± 2 hours local time for each country and cached in Redis. A Vercel serverless function is triggered to fetch the cached results from the Redis database every time the user opens or refreshes the website.
              </p>
            </section>

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-widest mb-2">
                Sentiment analysis
              </h3>
              <p>
                Each headline is scored by a fine-tuned{" "}
                <a
                  href="https://huggingface.co/cardiffnlp/twitter-roberta-base-sentiment-latest"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-fg/95 light:text-black underline underline-offset-2 hover:opacity-70 transition-opacity"
                >
                  cardiffnlp RoBERTa model
                </a>{" "}
                The model is trained on 124 million tweets in the English language, and is excellent at identifying sentiment in short text snippets. Scores range from -1 (most negative) to +1 (most positive), with a ±0.1 neutral zone. A country's displayed score is the average across its scored headlines.
              </p>
            </section>

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-widest mb-2">
                Coverage
              </h3>
              <p>
                Coverage is dictated by the rate limits of the GNews, NewsData.io, Hugging Face, and Microsoft Azure Translator APIs. Therefore, small island nations, microstates, and countries with very limited online press presence are not covered.
                <br></br>
                Additionally, the covered countries are split into high & low priority groups based on their global media presence. High priority countries are updated every day from GNews, while low priority countries are updated every 2 days from NewsData.io.
                Some low priority countries that are currently covered may be removed if rate limits become difficult to manage.
              </p>
            </section>
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-widest mb-2">Disclaimer</h3>
              <p>
                The purpose of this project is purely to demonstrate the application of natural language processing for sentiment analysis and provide an interactive visualisation of media attitudes around the globe.
                <br></br>
                All results are derived from external sources. The featured headlines and sentiment scores are not representative of my personal/political views.
              </p>
            </section>

            {/* Footer */}
            <section className="flex items-center justify-evenly p-4 shrink-0">
              <a
              href="https://sajidahmed.co.uk"
              target="_blank"
              rel="noopener noreferrer"
              className="text-fg/95 light:text-black/75 hover:opacity-70 transition-opacity"
              aria-label="Visit website"
            >
              <Logo className="w-7" />
            </a>
            <a
                  href="https://github.com/sahmed0"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-3xl text-fg/95 light:text-black/75 hover:opacity-70 transition-opacity"
                >
                  <i className="fa-brands fa-github-alt"></i>
                </a>
                <p className="text-sm text-fg/95 light:text-black/75">
                  © 2026 Sajid Ahmed
                </p>
            </section>
          </div>

        </motion.div>
      )}
    </AnimatePresence>
  );
}
