# FlyGate Pitch Deck

## Principles

- **One idea per slide.** The title is the conclusion ("A stolen key still can't spend"), never a topic ("Security").
- **Same look as the product.** Brand blue `#3264FF`, navy text `#0F294D`, white background, Inter. Green `#00A86B` for pass, red `#E5484D` for blocked, violet `#6D4AFF` for post-quantum. Judges should feel the deck and the demo are one product.
- **Screenshots, not diagrams.** Use real screenshots from the demo wherever possible.
- **Big numbers.** `0 succeeded`, `US$0 lost`, `6 on-chain rules`, `4,627 bytes` are the heroes of their slides.
- **Say what's simulated.** One slide states what is on-chain and what is test mode. Judges will ask; saying it first earns trust.

## Slides (12 slides, about 4–5 minutes; skip the ◇ slides if you only have 3)

| # | Title | On the slide | Talk track |
|---|---|---|---|
| 1 | **FlyGate: AI books your flight. It can't overspend.** | Logo, tagline, track name "Post-Quantum AI Agents", team | "We let an AI agent spend your money without you having to trust it." |
| 2 | **Would you give an AI your credit card?** | Three risks with icons: the AI overspends, its key leaks, a quantum computer forges your signature | "Today an agent either asks you at every step, or it holds your whole card." |
| 3 ◇ | **Agents are starting to pay. Security hasn't caught up.** | Timeline: x402, Google AP2, Visa and Mastercard agent payments; NIST: ECDSA deprecated after 2030, disallowed after 2035 | "A payment mandate lives for months. It can't wait for 2035." (Re-check the NIST dates before presenting.) |
| 4 | **One sentence becomes 6 on-chain rules** | Home screenshot with the parsed chips, plus the "You said / Enforced by / Blocks" table | "The rules live on-chain, not in the AI's code. The AI can't change them." |
| 5 | **AI ranks. The gate decides.** | Agent search screenshot: 8 offers, 4 blocked with reasons, the agent's pick and why | "The cheapest flight is non-refundable. The AI could want it. It still can't buy it." |
| 6 | **Pay only when ticketed** | Gate check screenshot with all 8 steps checked | "Money waits in escrow. The merchant signs a ticket proof with ML-DSA-87. Only then does the contract pay." |
| 7 | **When things go wrong, the money stays with you** | Left: fare jumps to US$428, blocked. Right: booking fails, auto refund | "Other projects never show these two cases." |
| 8 | **Stolen key: 6 attacks, 0 succeeded** | Breach drill screenshot, huge `0 succeeded · US$0 lost` | "Even a quantum computer that breaks ECDSA can't raise the cap. That takes your ML-DSA-87 key." |
| 9 | **Built on what only QoreChain has** | Six building blocks: abstract accounts, spending rules, scoped EVM window, `pqcVerify`, ML-KEM-1024, QoreSign. ML-DSA-87 signature: 4,627 bytes | Maps to the judging rubric: "QoreChain tech usage, 25%." |
| 10 ◇ | **How we compare** | Table: AutoVoyage (dummy flights), fly402 (no ticket shown), BookerBob (hotels only) vs FlyGate | "We're the only one that issues a real booking and pays only on ticket." |
| 11 ◇ | **What's real, and what's next** | Real: signatures, encryption, gate rules. Test mode: Duffel. Roadmap: live on diana testnet → Duffel live → Celo version with Self Agent ID | Answer the first judge question before they ask it. |
| 12 | **FlyGate: agents you can trust with money** | Tagline, QR codes for the repo and the demo, team | End on the same sentence you opened with. |

## 3-minute video (QoreChain requires ≤ 3 minutes)

The video is mostly live demo; slides only open and close it.

| Time | Content |
|---|---|
| 0:00–0:15 | Slide 2: "Would you give an AI your credit card?" |
| 0:15–2:40 | Live demo, following the 3-minute click path in `docs/FLOW.md` |
| 2:40–3:00 | Slide 9 (tech), then slide 12 (close) |

Voice-over lines for the demo part:

| Screen | Line |
|---|---|
| Book | "I type one sentence. FlyGate turns it into six rules." |
| Sign | "I sign once with a quantum-safe key. The rules go on-chain." |
| Agent search | "The agent fetches eight fares. The gate blocks four of them, and says why." |
| Gate check (blocked) | "The fare just jumped to 428 dollars. The gate stops the agent before it pays." |
| Gate check (rebook) | "It books the next flight. Money is released only after the ticket proof checks out." |
| Breach drill | "Now someone steals the agent's key. Six attacks. Zero succeed." |

## Judge Q&A

| Question | Answer |
|---|---|
| Is the chain part real? | Signatures, encryption, and the gate are real today. In the submitted version, linking the agent key, the spending rules, and the escrow all run on the diana testnet, with explorer links. (Must be finished before submission.) |
| Airlines don't take crypto. How does this work? | FlyGate's merchant is the merchant of record. It takes fUSD and pays the airline through its Duffel account. That's how every crypto travel booking works today. |
| What if the AI gets prompt-injected? | The AI has no power to approve a purchase. The gate is fixed code, and the contract and spending rules check again on-chain. Nothing the AI says gets around them. |
| Why post-quantum? Isn't ECDSA enough? | Payment mandates and passport data live for years. Signatures can be forged later ("trust now, forge later"), and data can be decrypted later ("harvest now, decrypt later"). NIST has already scheduled ECDSA's retirement. |
| Where does the agent's key live? | On the agent's server, and we assume it will leak. That's why the rules live on-chain and one signature from you revokes it. |
| How is this different from AutoVoyage? | Their flights are dummy data, payment isn't tied to ticketing, and there's no post-quantum layer. |

## Production checklist

- [ ] Reset the demo from Demo controls, then take six full-screen screenshots: Book, Mandate signed, Agent search (during countdown), Gate check (all steps checked), E-ticket, Breach drill (all blocked)
- [ ] Two more screenshots: "Blocked by the gate" (Fare jumps) and the refund (Booking fails)
- [ ] Record a 10-second clip of the Booking fails scenario for the 3-minute video
- [ ] Pipeline diagram for slides 4–6 and the video: `public/pipeline.svg` (1600×720, also served at `/pipeline.svg`)
- [ ] Cover image: 16:9, at least 1200×675 (QoreChain submission requirement)
- [ ] Re-check the NIST dates on slide 3 before presenting
