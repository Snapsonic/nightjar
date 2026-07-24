/**
 * The hero visual: a stylized 2×2 grid of night camera views, drawn entirely
 * in SVG. No stock images, no fake screenshots — an abstraction of what
 * Nightjar sees at 2 a.m.: hills, a moon, a pair of eyes, one detection.
 */
export function NightScene({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 560 440"
      className={className}
      role="img"
      aria-labelledby="night-scene-title"
    >
      <title id="night-scene-title">
        Stylized grid of four night-time camera views, one showing a person
        detection box and one showing a nightjar&apos;s eyes shining in the
        dark.
      </title>

      <defs>
        <clipPath id="tile-a">
          <rect x="8" y="8" width="264" height="204" rx="12" />
        </clipPath>
        <clipPath id="tile-b">
          <rect x="288" y="8" width="264" height="204" rx="12" />
        </clipPath>
        <clipPath id="tile-c">
          <rect x="8" y="228" width="264" height="204" rx="12" />
        </clipPath>
        <clipPath id="tile-d">
          <rect x="288" y="228" width="264" height="204" rx="12" />
        </clipPath>
      </defs>

      {/* ---- Tile A: porch — hills, crescent, REC ---- */}
      <g clipPath="url(#tile-a)">
        <rect x="8" y="8" width="264" height="204" fill="#0e111b" />
        {/* stars */}
        <circle cx="52" cy="44" r="1.4" fill="#676b80" />
        <circle cx="120" cy="30" r="1" fill="#4b506a" />
        <circle cx="200" cy="56" r="1.3" fill="#676b80" />
        <circle cx="164" cy="88" r="0.9" fill="#4b506a" />
        <circle cx="240" cy="96" r="1.1" fill="#4b506a" />
        {/* crescent */}
        <path
          d="M212 38a17 17 0 1 0 15.5 24A14 14 0 0 1 212 38Z"
          fill="none"
          stroke="#5a5f78"
          strokeWidth="1.6"
        />
        {/* hills */}
        <path
          d="M8 172c34-26 62-38 92-38 36 0 52 22 86 22 32 0 56-14 86-30v86H8v-40Z"
          fill="#121626"
          stroke="#242b45"
          strokeWidth="1.4"
        />
        <path
          d="M8 196c40-14 88-20 132-16 48 4 90 16 132 8"
          fill="none"
          stroke="#242b45"
          strokeWidth="1.4"
        />
      </g>

      {/* ---- Tile B: yard — branch and eye-shine ---- */}
      <g clipPath="url(#tile-b)">
        <rect x="288" y="8" width="264" height="204" fill="#0e111b" />
        <circle cx="330" cy="52" r="1.2" fill="#676b80" />
        <circle cx="420" cy="34" r="1" fill="#4b506a" />
        <circle cx="500" cy="64" r="1.4" fill="#676b80" />
        <circle cx="466" cy="112" r="0.9" fill="#4b506a" />
        {/* branch */}
        <path
          d="M288 158c40-14 78-18 116-12s84 8 148 0"
          fill="none"
          stroke="#242b45"
          strokeWidth="2"
        />
        <path
          d="M372 148c8-10 14-22 16-36M430 146c-4-12-4-22-2-34"
          fill="none"
          stroke="#242b45"
          strokeWidth="1.4"
        />
        {/* faint body suggestion, drawn first so the eyes shine on top of it */}
        <path
          d="M382 140c6-8 16-12 26-11 10 1 18 6 22 13"
          fill="none"
          stroke="#1a2036"
          strokeWidth="6"
          strokeLinecap="round"
        />
        {/* the bird is invisible in the dark — only the eyes give it away */}
        <circle
          cx="398"
          cy="134"
          r="3.2"
          fill="var(--color-ember-500)"
          className="animate-eyeshine"
        />
        <circle
          cx="411"
          cy="132.5"
          r="3.2"
          fill="var(--color-ember-500)"
          className="animate-eyeshine"
        />
      </g>

      {/* ---- Tile C: driveway — detection ---- */}
      <g clipPath="url(#tile-c)">
        <rect x="8" y="228" width="264" height="204" fill="#0e111b" />
        <circle cx="60" cy="262" r="1.1" fill="#4b506a" />
        <circle cx="228" cy="252" r="1.3" fill="#676b80" />
        {/* driveway perspective */}
        <path
          d="M96 432 140 288h14l58 144"
          fill="none"
          stroke="#242b45"
          strokeWidth="1.4"
        />
        <path
          d="M118 396h96M130 356h66M138 322h44"
          stroke="#1a2036"
          strokeWidth="1.4"
        />
        {/* detection box */}
        <rect
          x="158"
          y="306"
          width="52"
          height="86"
          rx="4"
          fill="none"
          stroke="var(--color-ember-500)"
          strokeWidth="1.6"
          strokeDasharray="6 5"
        />
        {/* abstract figure */}
        <circle cx="184" cy="322" r="7" fill="none" stroke="#5a5f78" strokeWidth="1.6" />
        <path
          d="M184 330v28m0 0-10 26m10-26 10 26m-24-40h28"
          fill="none"
          stroke="#5a5f78"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <rect x="158" y="288" width="88" height="15" rx="3" fill="#171c2e" />
        <text
          x="165"
          y="299"
          fontFamily="ui-monospace, Menlo, monospace"
          fontSize="10"
          fill="var(--color-ember-400)"
        >
          person · 0.97
        </text>
      </g>

      {/* ---- Tile D: back gate — quiet ---- */}
      <g clipPath="url(#tile-d)">
        <rect x="288" y="228" width="264" height="204" fill="#0e111b" />
        <circle cx="336" cy="268" r="1.2" fill="#676b80" />
        <circle cx="470" cy="250" r="1" fill="#4b506a" />
        <circle
          cx="516"
          cy="286"
          r="1.6"
          fill="#8a8fa6"
          className="animate-eyeshine-late"
        />
        {/* fence */}
        <path
          d="M304 432V344m36 88v-84m36 84v-88m36 88v-84m36 84v-88m36 88v-84m36 84v-88"
          stroke="#242b45"
          strokeWidth="2"
        />
        <path d="M288 356h264M288 396h264" stroke="#242b45" strokeWidth="1.6" />
      </g>

      {/* ---- Tile frames + chrome (labels, REC) ---- */}
      <g fontFamily="ui-monospace, Menlo, monospace" fontSize="10">
        <rect
          x="8"
          y="8"
          width="264"
          height="204"
          rx="12"
          fill="none"
          stroke="#212739"
          strokeWidth="1.4"
        />
        <text x="22" y="200" fill="#676b80">
          cam-01 · porch · 02:41
        </text>
        <circle
          cx="252"
          cy="26"
          r="4"
          fill="var(--color-ember-500)"
          className="animate-rec"
        />
        <text x="222" y="30" fill="#868a9f">
          rec
        </text>

        <rect
          x="288"
          y="8"
          width="264"
          height="204"
          rx="12"
          fill="none"
          stroke="#212739"
          strokeWidth="1.4"
        />
        <text x="302" y="200" fill="#676b80">
          cam-02 · yard · 02:41
        </text>

        <rect
          x="8"
          y="228"
          width="264"
          height="204"
          rx="12"
          fill="none"
          stroke="var(--color-ember-600)"
          strokeWidth="1.4"
        />
        <text x="22" y="420" fill="#676b80">
          cam-03 · driveway · 02:41
        </text>

        <rect
          x="288"
          y="228"
          width="264"
          height="204"
          rx="12"
          fill="none"
          stroke="#212739"
          strokeWidth="1.4"
        />
        <text x="302" y="420" fill="#676b80">
          cam-04 · back gate · 02:41
        </text>
      </g>
    </svg>
  );
}
