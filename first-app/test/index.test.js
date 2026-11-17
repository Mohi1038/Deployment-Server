import nock from "nock";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, beforeEach, afterEach, test } from "node:test";
import assert from "node:assert";
import { Probot, ProbotOctokit } from "probot";

process.env.API_URL = "http://deploy.test";
process.env.DEPLOYMENT_API_TOKEN = "test-service-token";
const { default: app, parseCommand } = await import("../index.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(path.join(__dirname, "fixtures/mock-cert.pem"), "utf-8");
const issuePayload = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/issues.opened.json"), "utf-8"));

describe("parseCommand", () => {
  test("parses /deploy with and without a provider", () => {
    assert.deepEqual(parseCommand("/deploy"), { action: "deploy", provider: "cheapest" });
    assert.deepEqual(parseCommand("please /deploy aws now"), { action: "deploy", provider: "aws" });
    assert.deepEqual(parseCommand("/deploy do"), { action: "deploy", provider: "digitalocean" });
    assert.deepEqual(parseCommand("/launch google"), { action: "deploy", provider: "gcp" });
  });
  test("parses /update, /redeploy and /status", () => {
    assert.deepEqual(parseCommand("/update"), { action: "update" });
    assert.deepEqual(parseCommand("/redeploy"), { action: "update" });
    assert.deepEqual(parseCommand("/status"), { action: "status" });
  });
  test("ignores ordinary text that mentions deployment", () => {
    assert.equal(parseCommand("Deployment docs have a typo"), null);
    assert.equal(parseCommand("we should deploy to docker later"), null);
    assert.equal(parseCommand("/deployment"), null);
  });
});

describe("DeployBase bot", () => {
  let probot;
  beforeEach(() => {
    nock.disableNetConnect();
    probot = new Probot({ appId: 123, privateKey, Octokit: ProbotOctokit.defaults({ retry: { enabled: false }, throttle: { enabled: false } }) });
    probot.load(app);
  });
  afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); });

  test("/status comments the live deployment, authenticating with the service token", async () => {
    const api = nock("http://deploy.test", { reqheaders: { authorization: "Bearer test-service-token" } })
      .get("/api/deployments")
      .reply(200, { success: true, deployments: [{ id: 7, repo_name: "testing-things", status: "ready", vm_ip: "34.1.2.3", domain: "testingthings.34.1.2.3.sslip.io", ssl_enabled: 0, branch: "main", cloud_provider: "gcp", active_slot: "green", updated_at: "2026-11-16 10:00:00" }] });
    const gh = nock("https://api.github.com")
      .post("/app/installations/2/access_tokens").reply(200, { token: "test", permissions: { issues: "write" } })
      .post("/repos/hiimbex/testing-things/issues/1/comments", (body) => {
        assert.match(body.body, /READY/);
        assert.match(body.body, /http:\/\/testingthings\.34\.1\.2\.3\.sslip\.io/);
        assert.match(body.body, /GREEN/);
        return true;
      }).reply(200);

    await probot.receive({ name: "issue_comment", payload: { ...issuePayload, action: "created", sender: { login: "mohit" }, comment: { body: "/status", user: { type: "User" } } } });
    assert.deepStrictEqual(api.pendingMocks(), []);
    assert.deepStrictEqual(gh.pendingMocks(), []);
  });

  test("an issue without a slash command does nothing", async () => {
    const payload = { ...issuePayload, issue: { ...issuePayload.issue, title: "Deployment docs typo", body: "" } };
    await probot.receive({ name: "issues", payload }); // nock would throw on any request
  });
});
