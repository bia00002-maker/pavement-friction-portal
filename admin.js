async function loadReviewers() {
  const tbody = document.getElementById("reviewerTableBody");
  try {
    const res = await fetch("/api/admin/reviewers");
    const data = await res.json();
    const reviewers = data.reviewers || [];

    if (reviewers.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="padding: 2rem; text-align: center; color: var(--text-muted);">No reviewers invited yet. Click "+ Invite New Reviewer" to begin.</td></tr>`;
      return;
    }

    tbody.innerHTML = reviewers.map(r => {
      let statusBadge = "";
      if (r.status === "submitted" || r.is_locked) {
        statusBadge = `<span style="background: #dcfce7; color: #166534; padding: 0.25rem 0.5rem; border-radius: 4px; font-weight: 600;">Submitted / Locked</span>`;
      } else if (r.status === "in_progress") {
        statusBadge = `<span style="background: #fef3c7; color: #92400e; padding: 0.25rem 0.5rem; border-radius: 4px; font-weight: 600;">In Progress</span>`;
      } else {
        statusBadge = `<span style="background: #f1f5f9; color: #475569; padding: 0.25rem 0.5rem; border-radius: 4px; font-weight: 600;">Invited</span>`;
      }

      const submittedText = r.submitted_at ? r.submitted_at.replace("T", " ").substring(0, 16) + " UTC" : "—";
      const progressText = `${r.completed_count || 0} / 72`;
      const flagText = r.flagged_count || 0;

      let actionBtn = "";
      if (r.is_locked) {
        actionBtn = `<a href="/api/admin/download-package/${r.reviewer_id}" class="btn btn-primary" style="padding: 0.35rem 0.65rem; font-size: 0.8rem;">📦 Download Locked Package</a>`;
      } else {
        const link = `${window.location.origin}/index.html?token=${r.token}`;
        actionBtn = `<button onclick="copyToClipboard('${link}')" class="btn btn-secondary" style="padding: 0.35rem 0.65rem; font-size: 0.8rem;">🔗 Copy Reviewer Link</button>`;
      }

      return `
        <tr style="border-bottom: 1px solid var(--border-light);">
          <td style="padding: 0.75rem 0.5rem; font-weight: 700; color: var(--wvu-blue);">${r.reviewer_id}</td>
          <td style="padding: 0.75rem 0.5rem; font-weight: 500;">${r.full_name || '—'}</td>
          <td style="padding: 0.75rem 0.5rem; color: var(--text-secondary);">${r.organization || '—'}</td>
          <td style="padding: 0.75rem 0.5rem;">${statusBadge}</td>
          <td style="padding: 0.75rem 0.5rem; font-weight: 600;">${progressText}</td>
          <td style="padding: 0.75rem 0.5rem; color: ${flagText > 0 ? '#b45309' : 'var(--text-muted)'};">${flagText > 0 ? '⚑ ' + flagText : '0'}</td>
          <td style="padding: 0.75rem 0.5rem; font-size: 0.8rem; color: var(--text-muted);">${submittedText}</td>
          <td style="padding: 0.75rem 0.5rem; text-align: right;">${actionBtn}</td>
        </tr>
      `;
    }).join("");
  } catch (err) {
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="8" style="padding: 2rem; text-align: center; color: #ef4444;">Error loading reviewers: ${err.message}</td></tr>`;
  }
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    alert("Private reviewer link copied to clipboard:\n" + text);
  }).catch(() => {
    prompt("Copy this private reviewer link:", text);
  });
}

function openInviteModal() {
  document.getElementById("inviteModal").style.display = "flex";
}

function closeInviteModal() {
  document.getElementById("inviteModal").style.display = "none";
  document.getElementById("inviteForm").reset();
}

document.getElementById("btnCreateReviewer").onclick = openInviteModal;
document.getElementById("btnRefresh").onclick = loadReviewers;

document.getElementById("inviteForm").onsubmit = async (e) => {
  e.preventDefault();
  const payload = {
    full_name: document.getElementById("invName").value.trim(),
    organization: document.getElementById("invOrg").value.trim(),
    email: document.getElementById("invEmail").value.trim()
  };

  try {
    const res = await fetch("/api/admin/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    closeInviteModal();
    loadReviewers();
    const fullLink = `${window.location.origin}${data.link}`;
    copyToClipboard(fullLink);
  } catch (err) {
    alert("Error creating reviewer link: " + err.message);
  }
};

window.addEventListener("DOMContentLoaded", () => {
  loadReviewers();
});
