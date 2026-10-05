function renderMarkdown(md) {
  if (!md) return "";
  let html = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  html = html.replace(/^### (.*$)/gim, '<h5>$1</h5>');
  html = html.replace(/^## (.*$)/gim, '<h4>$1</h4>');
  html = html.replace(/^# (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^&gt; (.*$)/gim, '<blockquote>$1</blockquote>');
  html = html.replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/gim, '<em>$1</em>');
  html = html.replace(/^---$/gim, '<hr>');
  html = html.replace(/^\- (.*$)/gim, '<li>$1</li>');

  const paragraphs = html.split(/\n\s*\n/);
  return paragraphs.map(p => {
    p = p.trim();
    if (!p) return "";
    if (p.startsWith("<h") || p.startsWith("<blockquote") || p.startsWith("<hr") || p.startsWith("<li")) {
      return p;
    }
    return `<p>${p.replace(/\n/g, '<br>')}</p>`;
  }).join("\n");
}

// Client-side pure JS ZIP generator for standalone/serverless execution
function generateClientZip(files) {
  function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) {
      let byte = buf[i];
      crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
    }
    return (crc ^ (-1)) >>> 0;
  }
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }

  const parts = [];
  const centralDirs = [];
  let offset = 0;
  const encoder = new TextEncoder();

  for (const f of files) {
    const nameBytes = encoder.encode(f.name);
    const dataBytes = encoder.encode(f.content);
    const crc = crc32(dataBytes);

    const header = new Uint8Array(30);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, dataBytes.length, true);
    view.setUint32(22, dataBytes.length, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);

    parts.push(header, nameBytes, dataBytes);

    const cd = new Uint8Array(46);
    const cdView = new DataView(cd.buffer);
    cdView.setUint32(0, 0x02014b50, true);
    cdView.setUint16(4, 20, true);
    cdView.setUint16(6, 20, true);
    cdView.setUint16(8, 0, true);
    cdView.setUint16(10, 0, true);
    cdView.setUint16(12, 0, true);
    cdView.setUint16(14, 0, true);
    cdView.setUint32(16, crc, true);
    cdView.setUint32(20, dataBytes.length, true);
    cdView.setUint32(24, dataBytes.length, true);
    cdView.setUint16(28, nameBytes.length, true);
    cdView.setUint16(30, 0, true);
    cdView.setUint16(32, 0, true);
    cdView.setUint16(34, 0, true);
    cdView.setUint16(36, 0, true);
    cdView.setUint32(38, 0, true);
    cdView.setUint32(42, offset, true);

    centralDirs.push(cd, nameBytes);
    offset += header.length + nameBytes.length + dataBytes.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const c of centralDirs) cdSize += c.length;

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, cdSize, true);
  eocdView.setUint32(16, cdOffset, true);
  eocdView.setUint16(20, 0, true);

  return new Blob([...parts, ...centralDirs, eocd], { type: 'application/zip' });
}

async function sha256Text(str) {
  const buf = new TextEncoder().encode(str);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  const arr = Array.from(new Uint8Array(hashBuf));
  return arr.map(b => b.toString(16).padStart(2, '0')).join('');
}

const app = {
  isStandalone: false,
  token: null,
  reviewer: null,
  allCasesData: [],
  currentCaseNumber: 1,
  totalCases: 72,
  completedCases: new Set(),
  flaggedCases: new Set(),
  autosaveTimeout: null,
  currentRatingData: {
    rating: null,
    rationale: "",
    locator: "",
    source_id: "",
    ambiguity_flag: 0,
    ambiguity_note: ""
  },

  async init() {
    this.extractToken();
    this.bindEvents();
    await this.detectEnvironment();
    await this.loadCodebook();
    await this.loadSession();
  },

  extractToken() {
    const urlParams = new URLSearchParams(window.location.search);
    this.token = urlParams.get("token") || localStorage.getItem("reviewer_token") || "IR-DEMO";
    if (urlParams.get("token")) {
      localStorage.setItem("reviewer_token", urlParams.get("token"));
    }
  },

  async detectEnvironment() {
    try {
      const res = await fetch("/api/cases", { method: "HEAD" });
      this.isStandalone = !res.ok;
    } catch {
      this.isStandalone = true;
    }
  },

  setSaveStatus(status) {
    const indicator = document.getElementById("saveIndicator");
    if (!indicator) return;
    if (status === "saving") {
      indicator.className = "save-indicator saving";
      indicator.innerHTML = '<span class="icon">●</span> <span class="text">Saving…</span>';
    } else if (status === "saved") {
      indicator.className = "save-indicator saved";
      indicator.innerHTML = '<span class="icon">✓</span> <span class="text">Saved</span>';
    } else if (status === "error") {
      indicator.className = "save-indicator";
      indicator.style.color = "#f87171";
      indicator.innerHTML = '<span class="icon">!</span> <span class="text">Save failed</span>';
    }
  },

  showScreen(screenId) {
    const screens = [
      "screenWelcome",
      "screenReviewerInfo",
      "screenDeclaration",
      "screenQuickGuide",
      "screenCaseReview",
      "screenFinalReview",
      "screenThankYou"
    ];
    screens.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    });

    const targetMap = {
      welcome: "screenWelcome",
      reviewerInfo: "screenReviewerInfo",
      declaration: "screenDeclaration",
      quickGuide: "screenQuickGuide",
      caseReview: "screenCaseReview",
      finalReview: "screenFinalReview",
      thankYou: "screenThankYou"
    };

    const target = document.getElementById(targetMap[screenId] || screenId);
    if (target) {
      target.style.display = "block";
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  },

  async loadCodebook() {
    try {
      let cb = {};
      if (!this.isStandalone) {
        const res = await fetch("/api/codebook");
        if (res.ok) {
          const data = await res.json();
          cb = data.codebook || {};
        }
      } else {
        const res = await fetch("codebook.json");
        if (res.ok) cb = await res.json();
      }

      if (cb.locked_codebook) {
        const container = document.getElementById("dynamicCodebookDetails");
        if (container) {
          container.innerHTML = `
            <hr style="margin: 1.5rem 0; border: none; border-top: 1px solid var(--border-light);">
            <h3>Verbatim Locked Codebook (E2.1)</h3>
            <div class="codebook-rendered">${renderMarkdown(cb.locked_codebook)}</div>
          `;
        }
      }
    } catch (e) {
      console.warn("Could not preload codebook:", e);
    }
  },

  async loadSession() {
    this.setSaveStatus("saving");
    try {
      if (this.isStandalone) {
        // Load static cases
        const casesRes = await fetch("cases.json");
        this.allCasesData = await casesRes.json();
        this.totalCases = this.allCasesData.length || 72;

        // Load local reviewer data
        const localRev = localStorage.getItem("reviewer_info");
        this.reviewer = localRev ? JSON.parse(localRev) : {
          reviewer_id: "IR001",
          full_name: "",
          title: "",
          organization: "",
          email: "",
          is_locked: false
        };

        const localRatings = localStorage.getItem("reviewer_ratings");
        const ratingsMap = localRatings ? JSON.parse(localRatings) : {};
        this.completedCases = new Set(Object.keys(ratingsMap).map(Number));

        for (const [k, v] of Object.entries(ratingsMap)) {
          if (v.ambiguity_flag) this.flaggedCases.add(Number(k));
        }

        const decConfirmed = localStorage.getItem("declaration_confirmed") === "true";
        if (decConfirmed) document.getElementById("checkDeclarationAgree").checked = true;

        if (this.reviewer.full_name) document.getElementById("inputFullName").value = this.reviewer.full_name;
        if (this.reviewer.title) document.getElementById("inputTitle").value = this.reviewer.title;
        if (this.reviewer.organization) document.getElementById("inputOrg").value = this.reviewer.organization;
        if (this.reviewer.email) document.getElementById("inputEmail").value = this.reviewer.email;

        this.updateProgressUI();
        this.setSaveStatus("saved");

        if (this.reviewer.is_locked) {
          document.getElementById("displayReviewerId").textContent = this.reviewer.reviewer_id;
          document.getElementById("displaySubmissionHash").textContent = this.reviewer.submission_hash || "LOCKED";
          this.showScreen("thankYou");
        } else if (!this.reviewer.full_name) {
          this.showScreen("welcome");
        } else if (!decConfirmed) {
          this.showScreen("declaration");
        } else {
          let firstIncomplete = 1;
          for (let i = 1; i <= this.totalCases; i++) {
            if (!this.completedCases.has(i)) {
              firstIncomplete = i;
              break;
            }
          }
          this.currentCaseNumber = firstIncomplete;
          this.loadCase(this.currentCaseNumber);
          this.showScreen("caseReview");
        }
        return;
      }

      // Backend API mode
      const res = await fetch(`/api/session?token=${encodeURIComponent(this.token)}`);
      if (!res.ok) {
        this.isStandalone = true;
        return this.loadSession();
      }
      const data = await res.json();
      this.reviewer = data.reviewer;
      this.completedCases = new Set(data.completed_cases || []);
      this.totalCases = data.total_cases || 72;

      if (this.reviewer.full_name) document.getElementById("inputFullName").value = this.reviewer.full_name;
      if (this.reviewer.title) document.getElementById("inputTitle").value = this.reviewer.title;
      if (this.reviewer.organization) document.getElementById("inputOrg").value = this.reviewer.organization;
      if (this.reviewer.email) document.getElementById("inputEmail").value = this.reviewer.email;
      if (this.reviewer.expertise) document.getElementById("inputExpertise").value = this.reviewer.expertise;
      if (this.reviewer.experience_years) document.getElementById("inputExpYears").value = this.reviewer.experience_years;
      if (this.reviewer.country) document.getElementById("inputCountry").value = this.reviewer.country;

      if (data.declaration && data.declaration.confirmed) {
        document.getElementById("checkDeclarationAgree").checked = true;
      }

      this.updateProgressUI();
      this.setSaveStatus("saved");

      if (this.reviewer.is_locked) {
        document.getElementById("displayReviewerId").textContent = this.reviewer.reviewer_id;
        document.getElementById("displaySubmissionHash").textContent = this.reviewer.submission_hash || "LOCKED";
        this.showScreen("thankYou");
      } else if (!this.reviewer.full_name) {
        this.showScreen("welcome");
      } else if (!data.declaration || !data.declaration.confirmed) {
        this.showScreen("declaration");
      } else {
        let firstIncomplete = 1;
        for (let i = 1; i <= this.totalCases; i++) {
          if (!this.completedCases.has(i)) {
            firstIncomplete = i;
            break;
          }
        }
        this.currentCaseNumber = firstIncomplete;
        this.loadCase(this.currentCaseNumber);
        this.showScreen("caseReview");
      }
    } catch (err) {
      console.error("Error loading session:", err);
      this.isStandalone = true;
      this.setSaveStatus("error");
    }
  },

  async saveReviewerInfo(e) {
    if (e) e.preventDefault();
    const info = {
      token: this.token,
      full_name: document.getElementById("inputFullName").value.trim(),
      title: document.getElementById("inputTitle").value.trim(),
      organization: document.getElementById("inputOrg").value.trim(),
      email: document.getElementById("inputEmail").value.trim(),
      expertise: document.getElementById("inputExpertise").value.trim(),
      experience_years: document.getElementById("inputExpYears").value.trim(),
      country: document.getElementById("inputCountry").value.trim()
    };

    if (!info.full_name || !info.organization || !info.email) {
      alert("Name, organization, and email are required.");
      return;
    }

    this.setSaveStatus("saving");
    try {
      if (this.isStandalone) {
        this.reviewer = { ...this.reviewer, ...info };
        localStorage.setItem("reviewer_info", JSON.stringify(this.reviewer));
      } else {
        await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(info)
        });
      }
      this.setSaveStatus("saved");
      this.showScreen("declaration");
    } catch (err) {
      alert("Could not save reviewer information: " + err.message);
      this.setSaveStatus("error");
    }
  },

  async confirmDeclaration() {
    const agree = document.getElementById("checkDeclarationAgree").checked;
    if (!agree) {
      alert("Please confirm the Independence Declaration before proceeding.");
      return;
    }
    this.setSaveStatus("saving");
    try {
      if (this.isStandalone) {
        localStorage.setItem("declaration_confirmed", "true");
      } else {
        await fetch("/api/declare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: this.token, confirmed: true })
        });
      }
      this.setSaveStatus("saved");
      this.showScreen("quickGuide");
    } catch (err) {
      alert("Error confirming declaration: " + err.message);
      this.setSaveStatus("error");
    }
  },

  async loadCase(caseNum) {
    this.currentCaseNumber = caseNum;
    this.setSaveStatus("saving");
    try {
      let c = null;
      if (this.isStandalone) {
        c = this.allCasesData.find(item => item.case_number === caseNum);
        if (!c && this.allCasesData.length > 0) c = this.allCasesData[caseNum - 1];
        const localRatings = JSON.parse(localStorage.getItem("reviewer_ratings") || "{}");
        if (c) c.saved_rating = localRatings[caseNum] || null;
      } else {
        const res = await fetch(`/api/case/${caseNum}?token=${encodeURIComponent(this.token || "")}`);
        if (!res.ok) throw new Error("Could not load case data");
        c = await res.json();
      }

      if (!c) throw new Error("Case data not found");

      document.getElementById("caseDisplayNum").textContent = `Case ${c.case_number} of ${this.totalCases}`;
      document.getElementById("caseAgency").textContent = c.agency || "Agency";
      document.getElementById("caseDomain").textContent = `${c.domain_code} — ${c.domain_name}`;
      document.getElementById("caseDomainDef").textContent = c.domain_definition || "Not specified.";

      document.getElementById("evidenceSourceTag").textContent = `Source(s): ${c.source_id || 'N/A'}`;
      document.getElementById("evidenceLocatorHeader").textContent = `Locator: ${c.locator ? c.locator.substring(0, 45) + '...' : 'Refer to dossier'}`;
      
      const evidenceBodyEl = document.getElementById("evidenceBody");
      evidenceBodyEl.innerHTML = renderMarkdown(c.evidence_text || "(No evidence excerpt provided for this case)");

      document.getElementById("evidenceDocTitle").textContent = c.source_title || "—";
      document.getElementById("evidenceIssuingOrg").textContent = c.issuing_org || "—";
      document.getElementById("evidenceDate").textContent = c.source_date || "—";
      document.getElementById("evidenceLocatorDetails").textContent = c.locator || "—";

      const limContainer = document.getElementById("evidenceLimitationContainer");
      if (c.source_limitation && c.source_limitation.trim()) {
        limContainer.style.display = "block";
        document.getElementById("evidenceLimitationText").textContent = c.source_limitation;
      } else {
        limContainer.style.display = "none";
      }

      this.currentRatingData = {
        rating: null,
        rationale: "",
        locator: c.locator || "",
        source_id: c.source_id || "",
        ambiguity_flag: 0,
        ambiguity_note: ""
      };

      if (c.saved_rating) {
        this.currentRatingData = {
          rating: c.saved_rating.rating,
          rationale: c.saved_rating.rationale || "",
          locator: c.saved_rating.evidence_locator || c.locator || "",
          source_id: c.saved_rating.evidence_source_id || c.source_id || "",
          ambiguity_flag: c.saved_rating.ambiguity_flag ? 1 : 0,
          ambiguity_note: c.saved_rating.ambiguity_note || ""
        };
      }

      this.updateRatingUI();
      this.updateProgressUI();
      this.setSaveStatus("saved");
    } catch (err) {
      console.error(err);
      this.setSaveStatus("error");
    }
  },

  selectRating(score) {
    this.currentRatingData.rating = score;
    this.updateRatingUI();
    this.triggerAutosave(true);
  },

  updateRatingUI() {
    document.querySelectorAll(".rating-btn[data-rating]").forEach(btn => {
      if (btn.getAttribute("data-rating") === this.currentRatingData.rating) {
        btn.classList.add("selected");
      } else {
        btn.classList.remove("selected");
      }
    });

    document.getElementById("inputRationale").value = this.currentRatingData.rationale || "";
    document.getElementById("inputEvidenceLocator").value = this.currentRatingData.locator || "";
    document.getElementById("checkAmbiguityFlag").checked = Boolean(this.currentRatingData.ambiguity_flag);

    const noteCont = document.getElementById("ambiguityNoteContainer");
    if (this.currentRatingData.ambiguity_flag) {
      noteCont.style.display = "block";
      document.getElementById("inputAmbiguityNote").value = this.currentRatingData.ambiguity_note || "";
    } else {
      noteCont.style.display = "none";
      document.getElementById("inputAmbiguityNote").value = "";
    }

    document.getElementById("btnPrevCase").disabled = (this.currentCaseNumber <= 1);
    if (this.currentCaseNumber >= this.totalCases) {
      document.getElementById("btnNextCase").textContent = "Proceed to Final Review →";
    } else {
      document.getElementById("btnNextCase").textContent = "Save & Continue →";
    }
  },

  toggleAmbiguityNote() {
    const isChecked = document.getElementById("checkAmbiguityFlag").checked;
    this.currentRatingData.ambiguity_flag = isChecked ? 1 : 0;
    const noteCont = document.getElementById("ambiguityNoteContainer");
    noteCont.style.display = isChecked ? "block" : "none";
    this.triggerAutosave(true);
  },

  triggerAutosave(immediate = false) {
    clearTimeout(this.autosaveTimeout);

    const performSave = async () => {
      this.currentRatingData.rationale = document.getElementById("inputRationale").value;
      this.currentRatingData.locator = document.getElementById("inputEvidenceLocator").value;
      this.currentRatingData.ambiguity_note = document.getElementById("inputAmbiguityNote").value;

      if (!this.currentRatingData.rating) return;

      this.setSaveStatus("saving");
      try {
        if (this.isStandalone) {
          const localRatings = JSON.parse(localStorage.getItem("reviewer_ratings") || "{}");
          localRatings[this.currentCaseNumber] = {
            rating: this.currentRatingData.rating,
            rationale: this.currentRatingData.rationale,
            evidence_locator: this.currentRatingData.locator,
            evidence_source_id: this.currentRatingData.source_id,
            ambiguity_flag: this.currentRatingData.ambiguity_flag,
            ambiguity_note: this.currentRatingData.ambiguity_note,
            updated_at: new Date().toISOString()
          };
          localStorage.setItem("reviewer_ratings", JSON.stringify(localRatings));
        } else {
          const payload = {
            token: this.token,
            case_number: this.currentCaseNumber,
            rating: this.currentRatingData.rating,
            rationale: this.currentRatingData.rationale,
            locator: this.currentRatingData.locator,
            source_id: this.currentRatingData.source_id,
            ambiguity_flag: this.currentRatingData.ambiguity_flag,
            ambiguity_note: this.currentRatingData.ambiguity_note
          };
          await fetch("/api/rate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
        }

        this.completedCases.add(this.currentCaseNumber);
        if (this.currentRatingData.ambiguity_flag) {
          this.flaggedCases.add(this.currentCaseNumber);
        } else {
          this.flaggedCases.delete(this.currentCaseNumber);
        }
        this.updateProgressUI();
        this.setSaveStatus("saved");
      } catch (err) {
        console.error("Autosave error:", err);
        this.setSaveStatus("error");
      }
    };

    if (immediate) {
      performSave();
    } else {
      this.setSaveStatus("saving");
      this.autosaveTimeout = setTimeout(performSave, 700);
    }
  },

  prevCase() {
    if (this.currentCaseNumber > 1) {
      this.triggerAutosave(true);
      this.loadCase(this.currentCaseNumber - 1);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  },

  nextCase() {
    const rationale = document.getElementById("inputRationale").value.trim();
    if (!this.currentRatingData.rating) {
      alert("Please select one of the four ratings before continuing.");
      return;
    }
    if (!rationale) {
      alert("Please provide a brief explanation (rationale) for your rating.");
      document.getElementById("inputRationale").focus();
      return;
    }

    this.triggerAutosave(true);

    if (this.currentCaseNumber >= this.totalCases) {
      this.showFinalReview();
    } else {
      this.loadCase(this.currentCaseNumber + 1);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  },

  goToCase(caseNum) {
    this.closeCasesNav();
    this.loadCase(caseNum);
    this.showScreen("caseReview");
  },

  updateProgressUI() {
    const done = this.completedCases.size;
    const pct = Math.round((done / this.totalCases) * 100);
    const progressText = document.getElementById("caseProgressText");
    const progressBar = document.getElementById("caseProgressBar");

    if (progressText) {
      progressText.textContent = `Case ${this.currentCaseNumber} of ${this.totalCases} · ${pct}% complete`;
    }
    if (progressBar) {
      progressBar.style.width = `${pct}%`;
    }

    this.renderCasesNavGrid();
  },

  showFinalReview() {
    document.getElementById("finalCompletedCount").textContent = this.completedCases.size;
    document.getElementById("flaggedCasesCount").textContent = this.flaggedCases.size;
    this.showScreen("finalReview");
  },

  reviewFlagged() {
    const flaggedArr = Array.from(this.flaggedCases).sort((a, b) => a - b);
    if (flaggedArr.length === 0) {
      alert("You have not flagged any cases as ambiguous or difficult.");
      return;
    }
    this.goToCase(flaggedArr[0]);
  },

  async submitFinal() {
    const confirm = document.getElementById("checkFinalConfirm").checked;
    if (!confirm) {
      alert("Please confirm the affirmation statement before submitting.");
      return;
    }

    if (this.completedCases.size < this.totalCases) {
      alert(`Cannot submit: Only ${this.completedCases.size} of ${this.totalCases} cases are completed.`);
      return;
    }

    if (!window.confirm("Are you sure you are ready to submit? Once submitted, your review is permanently locked.")) {
      return;
    }

    this.setSaveStatus("saving");
    try {
      if (this.isStandalone) {
        // Compile client-side locked package
        const now = new Date().toISOString();
        const dateStr = now.substring(0, 10);
        const revId = this.reviewer.reviewer_id || "IR001";
        const ratingsMap = JSON.parse(localStorage.getItem("reviewer_ratings") || "{}");

        // 1. Reviewer_Information.csv
        const infoCsv = `Field,Value\nReviewer_ID,${revId}\nFull_Name,${this.reviewer.full_name}\nTitle_Position,${this.reviewer.title}\nOrganization,${this.reviewer.organization}\nEmail,${this.reviewer.email}\nSubmitted_At,${now}\n`;

        // 2. Independent_Coder_Declaration.txt
        const decTxt = `INDEPENDENT EVIDENCE REVIEWER DECLARATION\n=========================================\nReviewer ID: ${revId}\nName: ${this.reviewer.full_name}\nConfirmed: YES\nTimestamp: ${now}\n`;

        // 3. Completed_72_Cell_Rationale_Form.csv
        let formCsv = "Reviewer_ID,Case_Number,Agency,Domain,Domain_Name,Rating,Rationale,Evidence_Source_ID,Evidence_Locator,Ambiguity_Flag,Ambiguity_Note,Saved_Timestamp,Final_Submission_ID\n";
        for (let i = 1; i <= 72; i++) {
          const c = this.allCasesData.find(item => item.case_number === i) || {};
          const r = ratingsMap[i] || {};
          formCsv += `"${revId}","${i}","${c.agency || ''}","${c.domain_code || ''}","${c.domain_name || ''}","${r.rating || ''}","${(r.rationale || '').replace(/"/g, '""')}","${c.source_id || ''}","${(r.evidence_locator || c.locator || '').replace(/"/g, '""')}","${r.ambiguity_flag || 0}","${(r.ambiguity_note || '').replace(/"/g, '""')}","${r.updated_at || now}","${revId}-${dateStr}"\n`;
        }

        // 4. Completed_9x8_Coding_Matrix.csv
        const agencies = Array.from(new Set(this.allCasesData.map(c => c.agency))).filter(Boolean);
        const domains = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'];
        let matrixCsv = "Agency," + domains.join(",") + "\n";
        for (const ag of agencies) {
          const row = [ag];
          for (const dm of domains) {
            const matchCase = this.allCasesData.find(c => c.agency === ag && c.domain_code === dm);
            const num = matchCase ? matchCase.case_number : 0;
            row.push(ratingsMap[num] ? ratingsMap[num].rating : "");
          }
          matrixCsv += row.join(",") + "\n";
        }

        // Checksums
        const hInfo = await sha256Text(infoCsv);
        const hDec = await sha256Text(decTxt);
        const hForm = await sha256Text(formCsv);
        const hMatrix = await sha256Text(matrixCsv);
        const masterHash = await sha256Text(hInfo + hDec + hForm + hMatrix);

        // 5. Submission_Hash.txt
        const hashTxt = `SUBMISSION INTEGRITY VERIFICATION\nReviewer ID: ${revId}\nSubmitted At: ${now}\nMaster SHA-256 Hash: ${masterHash}\n\n- Reviewer_Information.csv: ${hInfo}\n- Independent_Coder_Declaration.txt: ${hDec}\n- Completed_72_Cell_Rationale_Form.csv: ${hForm}\n- Completed_9x8_Coding_Matrix.csv: ${hMatrix}\n`;

        // 6. Submission_Manifest.json
        const manifestJson = JSON.stringify({
          reviewer_id: revId,
          full_name: this.reviewer.full_name,
          organization: this.reviewer.organization,
          submission_date: now,
          cases_completed: Object.keys(ratingsMap).length,
          master_sha256: masterHash
        }, null, 2);

        // Build ZIP and download
        const zipBlob = generateClientZip([
          { name: "Reviewer_Information.csv", content: infoCsv },
          { name: "Independent_Coder_Declaration.txt", content: decTxt },
          { name: "Completed_72_Cell_Rationale_Form.csv", content: formCsv },
          { name: "Completed_9x8_Coding_Matrix.csv", content: matrixCsv },
          { name: "Submission_Hash.txt", content: hashTxt },
          { name: "Submission_Manifest.json", content: manifestJson }
        ]);

        const a = document.createElement("a");
        a.href = URL.createObjectURL(zipBlob);
        a.download = `${revId}_Independent_Coding_RETURN_LOCKED_${dateStr}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        this.reviewer.is_locked = true;
        this.reviewer.submission_hash = masterHash;
        localStorage.setItem("reviewer_info", JSON.stringify(this.reviewer));

        document.getElementById("displayReviewerId").textContent = revId;
        document.getElementById("displaySubmissionHash").textContent = masterHash;
        this.showScreen("thankYou");
        return;
      }

      // Backend API submission
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: this.token, confirmed: true })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Submission failed");

      document.getElementById("displayReviewerId").textContent = data.reviewer_id;
      document.getElementById("displaySubmissionHash").textContent = data.submission_hash;
      this.showScreen("thankYou");
    } catch (err) {
      alert("Submission error: " + err.message);
      this.setSaveStatus("error");
    }
  },

  renderCasesNavGrid() {
    const grid = document.getElementById("casesNavGrid");
    if (!grid) return;
    grid.innerHTML = "";

    for (let i = 1; i <= this.totalCases; i++) {
      const cell = document.createElement("div");
      cell.className = "case-grid-cell";
      cell.textContent = i;

      if (i === this.currentCaseNumber) {
        cell.classList.add("active");
      } else if (this.completedCases.has(i)) {
        cell.classList.add("completed");
      }

      if (this.flaggedCases.has(i)) {
        cell.classList.add("flagged");
      }

      cell.onclick = () => this.goToCase(i);
      grid.appendChild(cell);
    }
  },

  openCodebook() {
    document.getElementById("codebookDrawer").classList.add("open");
    document.getElementById("codebookBackdrop").classList.add("open");
  },

  closeCodebook() {
    document.getElementById("codebookDrawer").classList.remove("open");
    document.getElementById("codebookBackdrop").classList.remove("open");
  },

  openCasesNav() {
    this.renderCasesNavGrid();
    document.getElementById("casesNavDrawer").classList.add("open");
    document.getElementById("casesNavBackdrop").classList.add("open");
  },

  closeCasesNav() {
    document.getElementById("casesNavDrawer").classList.remove("open");
    document.getElementById("casesNavBackdrop").classList.remove("open");
  },

  bindEvents() {
    document.getElementById("btnBeginReview").onclick = () => this.showScreen("reviewerInfo");
    document.getElementById("reviewerInfoForm").onsubmit = (e) => this.saveReviewerInfo(e);
    document.getElementById("btnConfirmDeclaration").onclick = () => this.confirmDeclaration();
    document.getElementById("btnStartCases").onclick = () => {
      this.loadCase(1);
      this.showScreen("caseReview");
    };
    document.getElementById("btnSubmitFinal").onclick = () => this.submitFinal();

    document.getElementById("inputRationale").oninput = () => this.triggerAutosave(false);
    document.getElementById("inputEvidenceLocator").oninput = () => this.triggerAutosave(false);
    document.getElementById("inputAmbiguityNote").oninput = () => this.triggerAutosave(false);

    document.getElementById("btnOpenCodebook").onclick = () => this.openCodebook();
    document.getElementById("btnCloseCodebook").onclick = () => this.closeCodebook();
    document.getElementById("codebookBackdrop").onclick = () => this.closeCodebook();

    document.getElementById("btnOpenNavModal").onclick = () => this.openCasesNav();
    document.getElementById("btnCloseCasesNav").onclick = () => this.closeCasesNav();
    document.getElementById("casesNavBackdrop").onclick = () => this.closeCasesNav();

    window.addEventListener("keydown", (e) => {
      if (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA") {
        return;
      }
      if (e.key === "1") this.selectRating("1");
      if (e.key === "2") this.selectRating("2");
      if (e.key === "0") this.selectRating("0");
      if (e.key.toLowerCase() === "n") this.selectRating("NR");
      if (e.key === "ArrowRight") this.nextCase();
      if (e.key === "ArrowLeft") this.prevCase();
    });
  }
};

window.addEventListener("DOMContentLoaded", () => {
  app.init();
});
