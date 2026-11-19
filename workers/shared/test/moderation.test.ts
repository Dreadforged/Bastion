import { describe, expect, it } from "vitest";
import { EventPayloads } from "../src/gateway.js";
import { newId } from "../src/ids.js";
import {
  AuditLogQuery,
  BanRequest,
  CreateReportRequest,
  MODERATION_LIMITS,
  ReportListQuery,
  TimeoutRequest,
  UpdateReportRequest,
} from "../src/moderation.js";
import { CreateChannelRequest, Member, UpdateChannelRequest } from "../src/servers.js";

const message = (content = "hi") => ({ id: newId(), content });

describe("report requests", () => {
  it("need one to 25 distinct messages", () => {
    const base = { channelId: newId(), category: "spam" };
    expect(CreateReportRequest.safeParse({ ...base, messages: [message()] }).success).toBe(true);
    expect(CreateReportRequest.safeParse({ ...base, messages: [] }).success).toBe(false);
    const many = Array.from({ length: MODERATION_LIMITS.maxReportMessages + 1 }, () => message());
    expect(CreateReportRequest.safeParse({ ...base, messages: many }).success).toBe(false);
    const dupe = message();
    expect(CreateReportRequest.safeParse({ ...base, messages: [dupe, dupe] }).success).toBe(false);
  });

  it("cap message text and note length and check the category", () => {
    const base = { channelId: newId(), category: "harassment" };
    const long = "x".repeat(MODERATION_LIMITS.maxReportedMessageChars + 1);
    expect(CreateReportRequest.safeParse({ ...base, messages: [message(long)] }).success).toBe(false);
    const note = "x".repeat(MODERATION_LIMITS.maxReportNoteChars + 1);
    expect(CreateReportRequest.safeParse({ ...base, note, messages: [message()] }).success).toBe(false);
    expect(CreateReportRequest.safeParse({ ...base, category: "rude", messages: [message()] }).success).toBe(false);
  });

  it("only move between known statuses", () => {
    expect(UpdateReportRequest.safeParse({ status: "resolved" }).success).toBe(true);
    expect(UpdateReportRequest.safeParse({ status: "closed" }).success).toBe(false);
    expect(ReportListQuery.parse({}).limit).toBe(50);
    expect(ReportListQuery.safeParse({ limit: "500" }).success).toBe(false);
  });
});

describe("moderation actions", () => {
  it("bound timeouts to 28 days", () => {
    expect(TimeoutRequest.safeParse({ seconds: 60 }).success).toBe(true);
    expect(TimeoutRequest.safeParse({ seconds: 0 }).success).toBe(false);
    expect(TimeoutRequest.safeParse({ seconds: MODERATION_LIMITS.maxTimeoutSeconds + 1 }).success).toBe(false);
  });

  it("let bans delete up to a week of messages", () => {
    expect(BanRequest.parse({}).deleteMessageSeconds).toBe(0);
    expect(BanRequest.safeParse({ deleteMessageSeconds: MODERATION_LIMITS.maxBanDeleteSeconds + 1 }).success).toBe(false);
    expect(BanRequest.safeParse({ reason: "x".repeat(MODERATION_LIMITS.maxReasonChars + 1) }).success).toBe(false);
  });

  it("bound slow mode to six hours", () => {
    expect(CreateChannelRequest.parse({ name: "a" }).slowModeSeconds).toBe(0);
    expect(UpdateChannelRequest.safeParse({ slowModeSeconds: 21_600 }).success).toBe(true);
    expect(UpdateChannelRequest.safeParse({ slowModeSeconds: 21_601 }).success).toBe(false);
  });

  it("filter the audit log by known actions only", () => {
    expect(AuditLogQuery.safeParse({ action: "member.ban" }).success).toBe(true);
    expect(AuditLogQuery.safeParse({ action: "member.hug" }).success).toBe(false);
  });
});

describe("moderation events", () => {
  it("have payload schemas and members carry their timeout", () => {
    expect(EventPayloads.REPORT_CREATE).toBeDefined();
    expect(EventPayloads.AUDIT_LOG_ENTRY_CREATE).toBeDefined();
    const member = { serverId: newId(), userId: newId(), nick: null, roles: [], joinedAt: 1 };
    expect(Member.safeParse({ ...member, timeoutUntil: null }).success).toBe(true);
    expect(Member.safeParse(member).success).toBe(false);
  });
});
