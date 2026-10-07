import { useId } from 'react';

/** Decorative manuscript assembled on a drafting table. */
export default function BlueprintScene() {
  const id = useId().replace(/:/g, '');
  return (
    <div className="blueprint-scene" aria-hidden="true">
      <div className="blueprint-coordinate">FIG. 01 / A THOUGHT TAKES SHAPE</div>
      <svg viewBox="0 0 620 500" fill="none">
        <defs>
          <pattern id={`${id}-grid`} width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" stroke="#2458a0" strokeOpacity=".12" strokeWidth=".6" /></pattern>
        </defs>
        <rect x="20" y="20" width="580" height="450" fill={`url(#${id}-grid)`} />
        <g stroke="#275898" strokeWidth="1" opacity=".5"><path d="M10 40h20M20 30v20M590 40h20M600 30v20M10 460h20M20 450v20M590 460h20M600 450v20" /><path d="M102 56H477M102 51v10M477 51v10" /></g>
        <text x="250" y="48" className="blueprint-micro">SPACE FOR AN IDEA</text>
        <g className="blueprint-back-sheet">
          <path d="M105 98L441 65L477 416L140 449Z" fill="#e9e5da" stroke="#c6c2b7" />
          <path d="M124 115L429 85M127 126L432 96" stroke="#b5b4ae" />
        </g>
        <g className="blueprint-main-sheet">
          <rect x="133" y="84" width="330" height="352" fill="#fffdf6" stroke="#c4c8c7" />
          <path d="M151 84V436M133 115H463" stroke="#d7dfdf" />
          <text x="167" y="104" className="blueprint-micro">RESEARCH NOTEBOOK</text><text x="416" y="104" className="blueprint-micro">001</text>
          <g className="blueprint-title">
            <text x="168" y="158" className="blueprint-paper-title">What if.</text>
            <path d="M170 169H293" stroke="#bd553b" strokeWidth="2" />
            <text x="169" y="191" className="blueprint-micro">A QUESTION WORTH FOLLOWING</text>
          </g>
          <g className="blueprint-lines" stroke="#a6afb5" strokeWidth="2">
            <path d="M169 214H426M169 223H426M169 232H371" />
            <path d="M169 263H280M169 273H284M169 283H275M169 293H284M169 303H261M169 313H280M169 323H247" />
            <path d="M310 263H426M310 273H415M310 283H426M310 293H408M310 303H426M310 313H417M310 323H390" />
            <path d="M169 358H426M169 368H416M169 378H426M169 388H337" />
          </g>
          <g className="blueprint-proof" stroke="#285da6" strokeWidth="1.5"><rect x="161" y="252" width="132" height="80" strokeDasharray="4 3" /><path d="M158 349H435M158 344v10M435 344v10" /></g>
          <text x="168" y="415" className="blueprint-micro">QUESTION → EVIDENCE → MANUSCRIPT</text>
        </g>
        <g className="blueprint-note">
          <path d="M395 220L562 236L546 356L379 340Z" fill="#254f88" />
          <g transform="rotate(5 470 287)"><text x="406" y="254" fill="#b9cce7" fontSize="9" fontFamily="monospace">FIELD NOTE / 02</text><text x="406" y="283" fill="#fffdf4" fontFamily="Georgia, serif" fontSize="24">Find the</text><text x="406" y="310" fill="#fffdf4" fontFamily="Georgia, serif" fontSize="24" fontStyle="italic">connection.</text><path d="M406 326H520" stroke="#8fa9cd" /></g>
        </g>
        <g className="blueprint-mark" stroke="#b54e37" strokeWidth="2" strokeLinecap="round"><path pathLength="1" d="M295 164C331 176 338 198 332 222C326 248 365 264 389 267" /><path d="M380 260l10 7-11 4" /><ellipse cx="283" cy="153" rx="60" ry="29" transform="rotate(-8 283 153)" /></g>
        <g className="blueprint-stamp" transform="rotate(-8 104 362)"><rect x="44" y="344" width="119" height="38" rx="2" fill="#f5f2e9" stroke="#b54e37" /><text x="58" y="369" fill="#b54e37" fontFamily="monospace" fontSize="13" letterSpacing="2">IN PROGRESS</text></g>
        <text x="402" y="477" className="blueprint-micro">DRAWN FROM CURIOSITY.</text>
      </svg>
      <div className="blueprint-caption"><span>01 — QUESTION</span><span>02 — DISCOVER</span><span>03 — CREATE</span></div>
    </div>
  );
}
