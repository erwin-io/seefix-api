const form =
  document.querySelector("#assessmentForm");

const imageInput =
  document.querySelector("#imageInput");

const dropZone =
  document.querySelector("#dropZone");

const preview =
  document.querySelector("#preview");

const previewPlaceholder =
  document.querySelector("#previewPlaceholder");

const fileName =
  document.querySelector("#fileName");

const analyzeButton =
  document.querySelector("#analyzeButton");

const clearButton =
  document.querySelector("#clearButton");

const requestStatus =
  document.querySelector("#requestStatus");

const results =
  document.querySelector("#results");

const priorityBar =
  document.querySelector("#priorityBar");

const priorityTrack =
  document.querySelector("#priorityTrack");


let selectedFile = null;
let previewUrl = null;


const allowedTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);


/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function valueOrDash(value) {
  return value === undefined ||
    value === null ||
    value === ""
    ? "—"
    : String(value);
}


function setText(id, value) {
  const element =
    document.getElementById(id);

  if (element) {
    element.textContent =
      valueOrDash(value);
  }
}


function titleCase(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(
      /\b\w/g,
      (letter) => letter.toUpperCase(),
    );
}


function asArray(value) {
  return Array.isArray(value)
    ? value
    : [];
}


/*
|--------------------------------------------------------------------------
| Lists
|--------------------------------------------------------------------------
*/

function renderList(
  id,
  items,
  emptyText = "No items reported.",
) {
  const list =
    document.getElementById(id);

  list.replaceChildren();

  const values =
    asArray(items).filter(Boolean);

  if (!values.length) {
    const item =
      document.createElement("li");

    item.className =
      "empty-item";

    item.textContent =
      emptyText;

    list.append(item);

    return;
  }

  for (const value of values) {
    const item =
      document.createElement("li");

    item.textContent =
      String(value);

    list.append(item);
  }
}


/*
|--------------------------------------------------------------------------
| Pills
|--------------------------------------------------------------------------
*/

function renderPills(id, items) {
  const container =
    document.getElementById(id);

  container.replaceChildren();

  const values =
    asArray(items).filter(Boolean);

  if (!values.length) {
    const pill =
      document.createElement("span");

    pill.className =
      "pill muted-pill";

    pill.textContent =
      "None reported";

    container.append(pill);

    return;
  }

  for (const value of values) {
    const pill =
      document.createElement("span");

    pill.className =
      "pill";

    pill.textContent =
      String(value);

    container.append(pill);
  }
}


/*
|--------------------------------------------------------------------------
| Risk Flags
|--------------------------------------------------------------------------
*/

function renderRiskFlags(flags = {}) {
  const container =
    document.getElementById(
      "riskFlags",
    );

  container.replaceChildren();


  const knownFlags = [
    [
      "immediate_danger",
      "Immediate danger",
    ],

    [
      "electrical_exposure",
      "Electrical exposure",
    ],

    [
      "fire_or_smoke_indicator",
      "Fire or smoke",
    ],

    [
      "structural_instability_indicator",
      "Structural instability",
    ],

    [
      "active_flooding",
      "Active flooding",
    ],

    [
      "blocked_access_or_exit",
      "Blocked access / exit",
    ],

    [
      "public_access_exposure",
      "Public access exposure",
    ],
  ];


  const seen =
    new Set();

  const entries = [];


  /*
   * Render known flags in a stable order.
   */
  for (
    const [key, label]
    of knownFlags
  ) {
    if (
      Object.prototype
        .hasOwnProperty
        .call(flags, key)
    ) {
      entries.push([
        key,
        label,
        Boolean(flags[key]),
      ]);

      seen.add(key);
    }
  }


  /*
   * Also support future risk flags
   * returned by the agent.
   */
  for (
    const [key, value]
    of Object.entries(flags || {})
  ) {
    if (!seen.has(key)) {
      entries.push([
        key,
        titleCase(key),
        Boolean(value),
      ]);
    }
  }


  if (!entries.length) {
    const empty =
      document.createElement("p");

    empty.className =
      "empty-copy";

    empty.textContent =
      "No risk flags returned by the agent.";

    container.append(empty);

    return;
  }


  for (
    const [, label, active]
    of entries
  ) {
    const row =
      document.createElement("label");

    row.className =
      `risk-row ${
        active
          ? "risk-active"
          : "risk-clear"
      }`;


    const checkbox =
      document.createElement("input");

    checkbox.type =
      "checkbox";

    checkbox.checked =
      active;

    checkbox.disabled =
      true;


    const copy =
      document.createElement("span");

    copy.className =
      "risk-copy";


    const name =
      document.createElement("strong");

    name.textContent =
      label;


    const state =
      document.createElement("small");

    state.textContent =
      active
        ? "Detected"
        : "Not detected";


    copy.append(
      name,
      state,
    );

    row.append(
      checkbox,
      copy,
    );

    container.append(row);
  }
}


/*
|--------------------------------------------------------------------------
| Badge Tone
|--------------------------------------------------------------------------
*/

function setTone(
  element,
  value,
) {
  const normalized =
    String(value || "")
      .toLowerCase();

  if (
    normalized.includes("high") ||
    normalized.includes("danger") ||
    normalized.includes("critical")
  ) {
    element.dataset.tone =
      "danger";

    return;
  }


  if (
    normalized.includes("medium") ||
    normalized.includes("moderate")
  ) {
    element.dataset.tone =
      "warning";

    return;
  }


  if (
    normalized.includes("low") ||
    normalized.includes("safe")
  ) {
    element.dataset.tone =
      "success";

    return;
  }


  element.dataset.tone =
    "neutral";
}


/*
|--------------------------------------------------------------------------
| Formatting
|--------------------------------------------------------------------------
*/

function formatDuration(
  minHours,
  maxHours,
) {
  if (
    minHours == null &&
    maxHours == null
  ) {
    return "—";
  }


  if (
    minHours != null &&
    maxHours != null &&
    minHours !== maxHours
  ) {
    return `${minHours}–${maxHours} hours`;
  }


  return `${
    minHours ?? maxHours
  } hours`;
}


function formatMilliseconds(value) {
  const ms =
    Number(value);

  if (!Number.isFinite(ms)) {
    return "—";
  }


  if (ms >= 1000) {
    return `${
      (ms / 1000).toFixed(2)
    } s`;
  }


  return `${ms} ms`;
}


function formatDimensions(
  width,
  height,
) {
  if (!width || !height) {
    return "—";
  }

  return `${width} × ${height}`;
}


/*
|--------------------------------------------------------------------------
| Normalize Agent Response
|--------------------------------------------------------------------------
|
| Hugging Face/Gradio may return the JSON object directly.
| This also handles the case where JSON is returned as a string.
|
*/

function normalizePayload(payload) {
  let current =
    payload;


  for (
    let attempt = 0;
    attempt < 2;
    attempt += 1
  ) {
    if (
      typeof current !== "string"
    ) {
      break;
    }


    try {
      current =
        JSON.parse(current);
    } catch {
      break;
    }
  }


  return current &&
    typeof current === "object"
    ? current
    : {};
}


/*
|--------------------------------------------------------------------------
| Render Assessment Result
|--------------------------------------------------------------------------
*/

function renderResult(rawPayload) {
  const data =
    normalizePayload(rawPayload);

  const scope =
    data.scope_validation || {};

  const assessment =
    data.assessment || {};

  const priority =
    data.priority || {};


  /*
   * Main result
   */

  setText(
    "analysisStatus",
    data.analysis_status || "Completed",
  );

  setText(
    "category",
    assessment.category,
  );

  setText(
    "summary",
    assessment.summary,
  );


  /*
   * Scope
   */

  setText(
    "scopeDecision",
    scope.decision,
  );

  setText(
    "scopeReason",
    scope.reason,
  );


  if (
    typeof scope.should_analyze ===
    "boolean"
  ) {
    setText(
      "scopeAnalyzeStatus",
      scope.should_analyze
        ? "Facility issue accepted"
        : "Outside assessment scope",
    );
  } else {
    setText(
      "scopeAnalyzeStatus",
      "—",
    );
  }


  /*
   * Urgency
   */

  setText(
    "urgency",
    assessment.recommended_urgency,
  );


  const urgencyBadge =
    document.getElementById(
      "urgency",
    );

  setTone(
    urgencyBadge,
    assessment.recommended_urgency,
  );


  /*
   * Certainty
   */

  setText(
    "certainty",
    assessment.analysis_certainty,
  );


  const certaintyBadge =
    document.getElementById(
      "certainty",
    );

  setTone(
    certaintyBadge,
    assessment.analysis_certainty,
  );


  /*
   * Duration
   */

  setText(
    "duration",
    formatDuration(
      assessment.estimated_min_hours,
      assessment.estimated_max_hours,
    ),
  );


  /*
   * Review requirement
   */

  if (
    typeof assessment.needs_review ===
    "boolean"
  ) {
    setText(
      "reviewStatus",
      assessment.needs_review
        ? "Review required"
        : "No review requested",
    );
  } else {
    setText(
      "reviewStatus",
      "—",
    );
  }


  /*
   * Priority
   */

  const total =
    priority.total;

  setText(
    "priorityScore",
    total,
  );

  setText(
    "priorityScoreLarge",
    total != null
      ? `${total} / 100`
      : "—",
  );


  const score =
    Math.max(
      0,
      Math.min(
        100,
        Number(total) || 0,
      ),
    );


  priorityBar.style.width =
    `${score}%`;

  priorityTrack.setAttribute(
    "aria-valuenow",
    String(score),
  );


  setText(
    "urgencyPoints",
    priority.urgency_points ?? 0,
  );

  setText(
    "recurrencePoints",
    priority.recurrence_points ?? 0,
  );

  setText(
    "verificationPoints",
    priority.verification_points ?? 0,
  );

  setText(
    "publicExposurePoints",
    priority.public_exposure_points ?? 0,
  );


  /*
   * Scope subjects
   */

  renderPills(
    "detectedSubjects",
    scope.detected_subjects,
  );


  /*
   * Assessment lists
   */

  renderList(
    "observedEvidence",
    assessment.observed_evidence,
    "No visual evidence listed.",
  );


  renderList(
    "possibleCauses",
    assessment.possible_causes,
    "No possible causes listed.",
  );


  renderList(
    "safetyIndicators",
    assessment.safety_indicators,
    "No safety indicators listed.",
  );


  renderList(
    "urgencyReasons",
    assessment.urgency_reasons,
    "No urgency reason returned.",
  );


  renderList(
    "durationAssumptions",
    assessment.duration_assumptions,
    "No duration assumptions returned.",
  );


  renderList(
    "followUpQuestions",
    assessment.follow_up_questions,
    "No follow-up questions returned.",
  );


  renderList(
    "limitations",
    assessment.limitations,
    "No limitations returned.",
  );


  /*
   * Checkbox risk flags
   */

  renderRiskFlags(
    assessment.risk_flags,
  );


  /*
   * Technical details
   */

  setText(
    "provider",
    data.provider,
  );

  setText(
    "modelId",
    data.model_id,
  );

  setText(
    "promptVersion",
    data.prompt_version,
  );

  setText(
    "processingTime",
    formatMilliseconds(
      data.processing_time_ms,
    ),
  );

  setText(
    "originalDimensions",
    formatDimensions(
      data.original_width,
      data.original_height,
    ),
  );

  setText(
    "processedDimensions",
    formatDimensions(
      data.processed_width,
      data.processed_height,
    ),
  );


  /*
   * Display result
   */

  results.hidden =
    false;


  results.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}


/*
|--------------------------------------------------------------------------
| Request Status
|--------------------------------------------------------------------------
*/

function setRequestStatus(
  message = "",
  type = "neutral",
) {
  requestStatus.textContent =
    message;

  requestStatus.dataset.type =
    type;

  requestStatus.hidden =
    !message;
}


/*
|--------------------------------------------------------------------------
| Loading State
|--------------------------------------------------------------------------
*/

function setLoading(loading) {
  analyzeButton.disabled =
    loading || !selectedFile;

  clearButton.disabled =
    loading;


  analyzeButton.classList.toggle(
    "is-loading",
    loading,
  );


  analyzeButton
    .querySelector(".button-label")
    .textContent =
      loading
        ? "Analyzing image…"
        : "Run assessment";
}


/*
|--------------------------------------------------------------------------
| Image Preview
|--------------------------------------------------------------------------
*/

function clearPreviewUrl() {
  if (previewUrl) {
    URL.revokeObjectURL(
      previewUrl,
    );
  }

  previewUrl =
    null;
}


function selectFile(file) {
  if (!file) {
    return;
  }


  if (
    !allowedTypes.has(file.type)
  ) {
    setRequestStatus(
      "Please choose a JPEG, PNG, or WebP image.",
      "error",
    );

    return;
  }


  selectedFile =
    file;


  clearPreviewUrl();


  previewUrl =
    URL.createObjectURL(file);


  preview.src =
    previewUrl;

  preview.hidden =
    false;

  previewPlaceholder.hidden =
    true;


  fileName.textContent =
    file.name;


  analyzeButton.disabled =
    false;


  /*
   * Hide previous result when
   * a different image is selected.
   */
  results.hidden =
    true;


  setRequestStatus("");
}


/*
|--------------------------------------------------------------------------
| Reset
|--------------------------------------------------------------------------
*/

function resetForm() {
  selectedFile =
    null;


  imageInput.value =
    "";


  clearPreviewUrl();


  preview.removeAttribute(
    "src",
  );

  preview.hidden =
    true;


  previewPlaceholder.hidden =
    false;


  fileName.textContent =
    "No image selected";


  results.hidden =
    true;


  analyzeButton.disabled =
    true;


  setRequestStatus("");
}


/*
|--------------------------------------------------------------------------
| File Input
|--------------------------------------------------------------------------
*/

imageInput.addEventListener(
  "change",
  () => {
    selectFile(
      imageInput.files?.[0],
    );
  },
);


clearButton.addEventListener(
  "click",
  resetForm,
);


/*
|--------------------------------------------------------------------------
| Drag & Drop
|--------------------------------------------------------------------------
*/

for (
  const eventName
  of [
    "dragenter",
    "dragover",
  ]
) {
  dropZone.addEventListener(
    eventName,
    (event) => {
      event.preventDefault();

      dropZone.classList.add(
        "is-dragging",
      );
    },
  );
}


for (
  const eventName
  of [
    "dragleave",
    "drop",
  ]
) {
  dropZone.addEventListener(
    eventName,
    (event) => {
      event.preventDefault();

      dropZone.classList.remove(
        "is-dragging",
      );
    },
  );
}


dropZone.addEventListener(
  "drop",
  (event) => {
    selectFile(
      event.dataTransfer?.files?.[0],
    );
  },
);


/*
|--------------------------------------------------------------------------
| Submit Assessment
|--------------------------------------------------------------------------
*/

form.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();


    if (!selectedFile) {
      setRequestStatus(
        "Select an image before running the assessment.",
        "error",
      );

      return;
    }


    const body =
      new FormData();


    body.append(
      "image",
      selectedFile,
      selectedFile.name,
    );


    setLoading(true);


    results.hidden =
      true;


    setRequestStatus(
      "Uploading the image and waiting for the assessment agent…",
      "info",
    );


    try {
      const response =
        await fetch(
          "/api/analyze",
          {
            method: "POST",
            body,
          },
        );


      const contentType =
        response.headers.get(
          "content-type",
        ) || "";


      const payload =
        contentType.includes(
          "application/json",
        )
          ? await response.json()
          : {
              detail:
                await response.text(),
            };


      if (!response.ok) {
        throw new Error(
          payload?.detail ||
          `Assessment failed with HTTP ${response.status}.`,
        );
      }


      renderResult(payload);


      setRequestStatus(
        "Assessment completed successfully.",
        "success",
      );
    } catch (error) {
      setRequestStatus(
        error instanceof Error
          ? error.message
          : "Assessment failed.",
        "error",
      );
    } finally {
      setLoading(false);
    }
  },
);