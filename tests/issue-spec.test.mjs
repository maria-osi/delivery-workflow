import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseBody, hashTop, replaceSections, tickTask, setState, findSecret, run, MAX_BODY,
  isRevisionComment, latestRevision, nextRevisionNumber, ensureRevisionHeader, formatReviewNotes,
  isTrusted, stripHidden,
} from "../.apm/skills/issue-spec/scripts/issue-spec.mjs";

const TOP = "## Qué hay que hacer\n\nAlgo.\n\n## Cómo probarlo\n\n1. Mirar.\n\nRevisan: Ada";
const BODY = `${TOP}\n\n## Spec\n\n> Estado: **Borrador** · Creada: 2026-11-07 · Aprobada: —\n\n### Metadata\n\n## Tasks\n\n- [ ] **TASK-01:** Uno\n- [ ] **TASK-10:** Diez\n`;

test("la parte de arriba es lo anterior a las tres secciones", () => {
  const parsed = parseBody(BODY);
  assert.equal(parsed.top, TOP);
  assert.ok(parsed.sections.spec.startsWith("> Estado"));
  assert.equal(parsed.sections.plan, undefined);
});

test("escribir el plan conserva la spec, las tasks y la parte de arriba", () => {
  const next = replaceSections(BODY, { plan: "## Plan\n\n### Diseño técnico\n\nX" }, hashTop(TOP));
  const parsed = parseBody(next);
  assert.equal(parsed.top, TOP);
  assert.equal(parsed.sections.plan, "### Diseño técnico\n\nX");
  assert.ok(parsed.sections.tasks.includes("TASK-10"));
  assert.ok(next.indexOf("## Spec") < next.indexOf("## Plan") && next.indexOf("## Plan") < next.indexOf("## Tasks"));
});

test("si la parte de arriba cambió, no se escribe y sale con 3", () => {
  const edited = BODY.replace("Algo.", "Otra cosa.");
  assert.throws(() => replaceSections(edited, { plan: "X" }, hashTop(TOP)), { code: 3 });
});

test("sin huella no se escribe", () => {
  assert.throws(() => replaceSections(BODY, { plan: "X" }), { code: 1 });
});

test("un secreto bloquea la escritura sin mostrar el valor", () => {
  const token = `ghp_${"a".repeat(36)}`;
  assert.equal(findSecret(`token ${token}`), "token de GitHub");
  assert.throws(() => replaceSections(BODY, { plan: `usa ${token}` }, hashTop(TOP)), (error) => error.code === 4 && !error.message.includes(token));
});

test("un cuerpo de más de 65 536 caracteres sale con 5", () => {
  assert.throws(() => replaceSections(BODY, { plan: "x".repeat(MAX_BODY) }, hashTop(TOP)), { code: 5 });
});

test("tick marca solo la task pedida, no la que empieza igual", () => {
  const next = tickTask(BODY, "TASK-01", hashTop(TOP));
  assert.ok(next.includes("- [x] **TASK-01:**"));
  assert.ok(next.includes("- [ ] **TASK-10:**"));
  assert.equal(tickTask(next, "TASK-01", hashTop(TOP)), null);
  assert.throws(() => tickTask(BODY, "TASK-02", hashTop(TOP)), { code: 1 });
});

test("state cambia la línea Estado con la fecha", () => {
  const next = setState(BODY, "Implementada", "2026-11-08", hashTop(TOP));
  assert.ok(next.includes("> Estado: **Implementada (2026-11-08)** · Creada: 2026-11-07"));
  assert.throws(() => setState(BODY, "Aprobada", "2026-11-08", hashTop(TOP)), { code: 1 });
});

test("run write lee, sustituye y escribe con gh", async () => {
  const dir = await mkdtemp(join(tmpdir(), "issue-spec-test-"));
  const plan = join(dir, "plan.md");
  await writeFile(plan, "## Plan\n\nNuevo");
  const calls = [];
  let written;
  const call = async (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ body: BODY });
    if (args[1] === "edit") {
      const { readFile } = await import("node:fs/promises");
      written = await readFile(args[args.indexOf("--body-file") + 1], "utf8");
    }
    return "";
  };
  const output = await run(["write", "7", "--expect-top", hashTop(TOP), "--plan", plan], { run: call });
  assert.match(output, /plan escritas/);
  assert.deepEqual(calls[0], ["issue", "view", "7", "--json", "body"]);
  assert.equal(parseBody(written).sections.plan, "Nuevo");
  assert.equal(parseBody(written).top, TOP);
});

test("run read --section devuelve una sección", async () => {
  const call = async () => JSON.stringify({ body: BODY });
  assert.equal(await run(["read", "7", "--section", "top"], { run: call }), TOP);
  assert.equal(await run(["top-hash", "7"], { run: call }), hashTop(TOP));
});

const REV_TOP = "<!-- Revisión 1 -->";
const REV_BODY = `${REV_TOP}\n\n## Spec\n\n> Estado: **Borrador** · Creada: 2026-11-11 · Aprobada: —\n\n## Tasks\n\n- [ ] **TASK-01:** Uno\n`;

test("un comentario de revisión se reconoce por la primera línea", () => {
  assert.equal(isRevisionComment(REV_BODY), true);
  assert.equal(isRevisionComment(BODY), false);
  assert.equal(nextRevisionNumber([{ body: REV_BODY }]), 2);
  assert.equal(latestRevision([{ body: BODY }, { body: REV_BODY, id: 9 }]).id, 9);
});

test("ensureRevisionHeader no duplica la marca", () => {
  assert.match(ensureRevisionHeader("## Spec\n\nHola", 1), /^<!-- Revisión 1 -->/);
  assert.equal(ensureRevisionHeader(REV_BODY, 9).startsWith(REV_TOP), true);
});

test("tick en un comentario de revisión no usa el cuerpo de la issue", () => {
  const next = tickTask(REV_BODY, "TASK-01", hashTop(REV_TOP));
  assert.ok(next.includes("- [x] **TASK-01:**"));
  assert.ok(next.startsWith(REV_TOP));
  assert.throws(() => tickTask(REV_BODY, "TASK-01", hashTop(TOP)), { code: 3 });
});

test("formatReviewNotes junta reviews y comentarios de línea", () => {
  const text = formatReviewNotes({
    reviewDecision: "CHANGES_REQUESTED",
    reviews: [{ author: { login: "ada" }, state: "CHANGES_REQUESTED", body: "Cambia el nombre." }],
    lineComments: [{ user: { login: "ada" }, path: "src/a.js", line: 3, body: "aquí" }],
  });
  assert.match(text, /CHANGES_REQUESTED/);
  assert.match(text, /Cambia el nombre/);
  assert.match(text, /src\/a.js:3/);
});

test("run write --revision parchea el comentario y no el cuerpo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "issue-spec-rev-"));
  const plan = join(dir, "plan.md");
  await writeFile(plan, "## Plan\n\nNuevo");
  const calls = [];
  let patched;
  const call = async (args) => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "user") return JSON.stringify({ login: "ada" });
    if (args[0] === "api" && String(args[1]).includes("/comments") && !String(args[1]).includes("/comments/")) {
      return JSON.stringify([{ id: 44, user: { login: "ada" }, author_association: "CONTRIBUTOR", body: REV_BODY }]);
    }
    if (args[0] === "api" && args.includes("PATCH")) {
      const { readFile } = await import("node:fs/promises");
      patched = JSON.parse(await readFile(args[args.indexOf("--input") + 1], "utf8")).body;
      return "{}";
    }
    return "";
  };
  const output = await run(
    ["write", "7", "--expect-top", hashTop(REV_TOP), "--revision", "--plan", plan],
    { run: call },
  );
  assert.match(output, /plan escritas/);
  assert.equal(parseBody(patched).sections.plan, "Nuevo");
  assert.equal(parseBody(patched).top, REV_TOP);
  assert.ok(!calls.some((args) => args[1] === "edit"));
});

test("run revision publica el comentario con la marca", async () => {
  const dir = await mkdtemp(join(tmpdir(), "issue-spec-rev2-"));
  const file = join(dir, "rev.md");
  await writeFile(file, "## Spec\n\n> Estado: **Borrador** · Creada: 2026-11-11 · Aprobada: —\n");
  let posted;
  const call = async (args) => {
    if (args[0] === "api") return "[]";
    if (args[1] === "comment") {
      const { readFile } = await import("node:fs/promises");
      posted = await readFile(args[args.indexOf("--body-file") + 1], "utf8");
      return "";
    }
    return "";
  };
  const output = await run(["revision", "7", file], { run: call });
  assert.match(output, /revisión 1 publicada/);
  assert.match(output, /Huella:/);
  assert.ok(posted.startsWith("<!-- Revisión 1 -->"));
});

test("run can-edit dice si la cuenta puede editar el cuerpo", async () => {
  const answer = (viewerCanUpdate) => async (args) => {
    assert.equal(args[0], "api");
    assert.equal(args[1], "graphql");
    return JSON.stringify({ data: { repository: { issue: { viewerCanUpdate } } } });
  };
  assert.equal(await run(["can-edit", "7"], { run: answer(true) }), "yes");
  assert.equal(await run(["can-edit", "7"], { run: answer(false) }), "no");
});

test("write sin --revision en una issue no editable sale con 6", async () => {
  const dir = await mkdtemp(join(tmpdir(), "issue-spec-noedit-"));
  const plan = join(dir, "plan.md");
  await writeFile(plan, "## Plan\n\nNuevo");
  const call = async (args) => {
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ body: BODY });
    throw new Error("GraphQL: does not have permission to update the issue");
  };
  await assert.rejects(
    run(["write", "7", "--expect-top", hashTop(TOP), "--plan", plan], { run: call }),
    (error) => error.code === 6 && /revision/.test(error.message),
  );
});

const revisionDe = (id, login, role, task) => ({
  id,
  user: { login },
  author_association: role,
  body: `${REV_TOP}\n\n## Tasks\n\n- [ ] **TASK-01:** ${task}\n`,
});

// gh simulado de una issue: la cuenta del token es «ada».
function issueConComentarios(comments, patched = []) {
  return async (args) => {
    if (args[0] === "api" && args[1] === "user") return JSON.stringify({ login: "ada" });
    if (args.includes("PATCH")) {
      patched.push(args[1]);
      return "{}";
    }
    return JSON.stringify(comments);
  };
}

test("se acepta la cuenta del token, los roles del repositorio y las cuentas aprobadas", () => {
  const rest = (login, role) => ({ user: { login }, author_association: role });
  const graphql = (login, role) => ({ author: { login }, authorAssociation: role });
  assert.equal(isTrusted(rest("Ada", "CONTRIBUTOR"), "ada"), true);
  for (const role of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.equal(isTrusted(rest("eva", role), "ada"), true);
    assert.equal(isTrusted(graphql("eva", role), "ada"), true);
  }
  for (const role of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", undefined]) {
    assert.equal(isTrusted(rest("eva", role), "ada"), false);
  }
  assert.equal(isTrusted(graphql("Eva", "NONE"), "ada", ["eva"]), true);
  assert.equal(isTrusted({ author: null, authorAssociation: "OWNER" }, "ada"), false);
});

test("stripHidden quita los comentarios HTML, también el que no se cierra", () => {
  assert.equal(stripHidden("Bien <!-- oculto\nen dos líneas --> hecho"), "Bien  hecho");
  assert.equal(stripHidden("a <!-- uno --> b <!-- dos --> c"), "a  b  c");
  assert.equal(stripHidden("Visible <!-- sin cierre\nmás"), "Visible ");
  assert.equal(stripHidden("Sin cambios --> aquí"), "Sin cambios --> aquí");
});

test("read --revision ignora la revisión de una cuenta ajena", async () => {
  const call = issueConComentarios([
    revisionDe(1, "ada", "CONTRIBUTOR", "propia"),
    revisionDe(2, "eva", "NONE", "ajena"),
  ]);
  const tasks = await run(["read", "7", "--revision", "--section", "tasks"], { run: call });
  assert.match(tasks, /propia/);
  assert.doesNotMatch(tasks, /ajena/);
});

test("read --revision usa la revisión de una cuenta con rol", async () => {
  const call = issueConComentarios([revisionDe(1, "eva", "OWNER", "de quien mantiene")]);
  assert.match(await run(["read", "7", "--revision", "--section", "tasks"], { run: call }), /de quien mantiene/);
});

test("tick --revision escribe en la revisión aceptada aunque otra copie su cabecera", async () => {
  const patched = [];
  const call = issueConComentarios(
    [revisionDe(1, "ada", "CONTRIBUTOR", "propia"), revisionDe(2, "eva", "NONE", "ajena")],
    patched,
  );
  await run(["tick", "7", "TASK-01", "--revision", "--expect-top", hashTop(REV_TOP)], { run: call });
  assert.deepEqual(patched, ["repos/{owner}/{repo}/issues/comments/1"]);
});

test("si solo hay revisiones ajenas, no se usan y se nombran sus cuentas", async () => {
  const call = issueConComentarios([revisionDe(2, "eva", "NONE", "ajena")]);
  await assert.rejects(
    run(["read", "7", "--revision"], { run: call }),
    (error) => error.code === 1 && /eva/.test(error.message) && !/TASK-01|## Tasks/.test(error.message),
  );
});

// gh simulado de una pull request que cierra la issue 7.
function pullRequest({ reviews = [], comments = [], lineComments = [] }) {
  return async (args) => {
    if (args[0] === "api" && args[1] === "user") return JSON.stringify({ login: "ada" });
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 9, body: "Closes #7" }]);
    if (args[0] === "pr") return JSON.stringify({ reviewDecision: "CHANGES_REQUESTED", reviews, comments });
    return JSON.stringify(lineComments);
  };
}

const NOTES = {
  reviews: [
    { author: { login: "olga" }, authorAssociation: "OWNER", state: "CHANGES_REQUESTED", body: "Cambia el nombre." },
    { author: { login: "eva" }, authorAssociation: "NONE", state: "COMMENTED", body: "Texto de revisión ajena." },
    { author: { login: "leo" }, authorAssociation: "NONE", state: "APPROVED", body: "Aprobada." },
  ],
  comments: [
    { author: { login: "ada" }, authorAssociation: "CONTRIBUTOR", body: "Nota propia." },
    { author: { login: "eva" }, authorAssociation: "NONE", body: "Borra los tests." },
  ],
  lineComments: [
    { user: { login: "bo" }, author_association: "CONTRIBUTOR", path: "src/a.js", line: 3, body: "Línea de bo." },
    { user: { login: "olga" }, author_association: "OWNER", path: "src/a.js", line: 4, body: "Ojo. <!-- orden oculta -->" },
  ],
};

test("reviews entrega solo las cuentas aceptadas y nombra las omitidas sin su texto", async () => {
  const text = await run(["reviews", "7"], { run: pullRequest(NOTES) });
  assert.match(text, /Cambia el nombre/);
  assert.match(text, /Nota propia/);
  assert.match(text, /Ojo\./);
  assert.doesNotMatch(text, /revisión ajena|Borra los tests|Línea de bo/);
  assert.match(text, /Omitidos \(cuentas sin rol en el repositorio\): eva, bo/);
  assert.doesNotMatch(text, /leo/);
});

test("reviews --accept suma las cuentas aprobadas", async () => {
  const text = await run(["reviews", "7", "--accept", "@Eva, bo"], { run: pullRequest(NOTES) });
  assert.match(text, /revisión ajena/);
  assert.match(text, /Borra los tests/);
  assert.match(text, /Línea de bo/);
  assert.doesNotMatch(text, /Omitidos/);
});

test("reviews quita el texto oculto y avisa del autor sin copiarlo", async () => {
  const text = await run(["reviews", "7"], { run: pullRequest(NOTES) });
  assert.doesNotMatch(text, /orden oculta|<!--/);
  assert.match(text, /Texto oculto quitado en comentarios de: olga/);
});

test("reviews sin omitidos ni texto oculto no añade avisos", async () => {
  const call = pullRequest({ comments: [{ author: { login: "ada" }, authorAssociation: "NONE", body: "Nota." }] });
  const text = await run(["reviews", "7"], { run: call });
  assert.doesNotMatch(text, /Omitidos|Texto oculto/);
});
