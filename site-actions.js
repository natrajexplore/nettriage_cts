// Registers NetTriage's operations with the agent runtime.
// agent-manifest.json loads this module through "actions.module". Only the names in
// "actions.agentTools" become model tools, called website_<name>.
// Every action wraps a method of App.page; no diagnosis rule is copied here.
import { App } from "./script.js";
import { DEVICES, LANGUAGES, PROBLEMS } from "./js/playbooks.js";

/**
 * Describes the site's operations as actions the agents can call.
 */
class SiteActions {
  /**
   * :param actions: The runtime registry facade with a register(definition) method.
   */
  static registerActions(actions) {
    actions.register(SiteActions.readStateAction());
    actions.register(SiteActions.runCheckupAction());
    actions.register(SiteActions.checkSiteAction());
    actions.register(SiteActions.fixStepsAction());
    actions.register(SiteActions.supportReportAction());
  }

  static supportReportAction() {
    return {
      name: "get_support_report",
      description: "Return a plain-text report of this visit's checkups and site check, for the visitor to send to their internet provider or IT helper. Holds measurements only. Changes nothing, and sends nothing to anyone. Returns ok false with a reason when nothing has been checked yet.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: SiteActions.supportReport,
    };
  }

  static supportReport() {
    return App.page.getSupportReport();
  }

  static readStateAction() {
    return {
      name: "get_triage_state",
      description: "Read the page: today's date, the browser's connection hints, the latest checkup (verdict, evidence, per-endpoint timings), the latest site check, which endpoints a checkup contacts, and what NetTriage cannot do. Changes nothing.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: SiteActions.readState,
    };
  }

  static readState() {
    return App.page.getState();
  }

  static runCheckupAction() {
    return {
      name: "run_checkup",
      description: "Run a new connection checkup from the visitor's browser (about 10-20 seconds) and show it on the page. Returns the verdict code, headline, evidence, metrics (typicalMs, lost, sent, worstJitterMs) and per-endpoint timings, or ok false with a reason. Replaces the previous checkup on the page.",
      effect: "write",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      timeoutMs: 90000,
      execute: SiteActions.runCheckup,
    };
  }

  static runCheckup() {
    return App.page.runCheckup();
  }

  static checkSiteAction() {
    return {
      name: "check_site",
      description: "Check whether one public website is down for everyone or only unreachable from this connection. Contacts that website and two public DNS resolvers, so the browser asks the visitor first. Returns the verdict code, headline and evidence, or ok false with a reason.",
      effect: "irreversible",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["site"],
        properties: {
          site: {
            type: "string",
            minLength: 1,
            maxLength: 253,
            description: "The website name exactly as the visitor gave it, such as example.com.",
          },
        },
      },
      timeoutMs: 60000,
      execute: SiteActions.checkSite,
    };
  }

  static checkSite(args) {
    return App.page.checkSite(args.site);
  }

  static fixStepsAction() {
    return {
      name: "get_fix_steps",
      description: "Return NetTriage's tested fix steps for one problem on one device, in English, Hindi or Tamil, with a closing line in the same language. Changes nothing.",
      effect: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["problem", "device"],
        properties: {
          problem: {
            type: "string",
            enum: Object.keys(PROBLEMS),
            description: "A verdict code from a checkup or site check, or the problem the visitor describes.",
          },
          device: {
            type: "string",
            enum: Object.keys(DEVICES),
            description: "The visitor's device; use router for steps on the home router or modem.",
          },
          language: {
            type: "string",
            enum: Object.keys(LANGUAGES),
            default: "en",
            description: "en English, hi Hindi, ta Tamil: the language the visitor writes in or asks for.",
          },
        },
      },
      execute: SiteActions.fixSteps,
    };
  }

  static fixSteps(args) {
    return App.page.getFixSteps(args.problem, args.device, args.language ?? "en");
  }
}

export const registerActions = SiteActions.registerActions;
