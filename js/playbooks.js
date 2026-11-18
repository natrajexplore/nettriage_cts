// Fix steps by problem and device. Safe, reversible steps a non-expert can follow.
// The assistant's fix_guide reads these through website_get_fix_steps; it does not invent steps.
// Hindi and Tamil translations live in playbooks.hi.js and playbooks.ta.js, step for step.
import * as hindi from "./playbooks.hi.js";
import * as tamil from "./playbooks.ta.js";

export const DEVICES = {
  windows: "Windows PC",
  macos: "Mac",
  android: "Android phone or tablet",
  iphone: "iPhone or iPad",
  router: "Home router or modem",
};

export const PROBLEMS = {
  offline: "Device not connected to any network",
  no_internet: "Connected to Wi-Fi or cable, but no internet",
  dns_problem: "Website names do not load (DNS)",
  unstable: "Connection drops or wobbles",
  slow: "Connection is slow",
  slow_setup: "Pages are slow to start loading",
  site_no_answer: "One website does not load",
  site_not_found: "Website name not found",
};

const COMMON = {
  restart_router: "Unplug the router and modem from power, wait 30 seconds, plug the modem in first, wait until its lights are steady (about 2 minutes), then plug in the router.",
  isp_status: "Check your internet provider's outage page or app using mobile data. If there is a reported outage, wait for it to be fixed.",
  isp_call: "If the router shows no internet light after a restart and there is no reported outage, contact your internet provider. Tell them the router restart did not help.",
  other_device: "Try another phone or computer on the same Wi-Fi. If it also fails, the problem is the router or provider, not this device.",
};

/**
 * Steps keyed by problem, then device. "all" applies to every device and comes first.
 */
export const PLAYBOOKS = {
  offline: {
    all: ["Check that Wi-Fi is turned on and airplane mode is off.", COMMON.other_device],
    windows: ["Click the network icon in the taskbar, choose your Wi-Fi network and connect.", "If it will not connect: Settings > Network & internet > Advanced network settings > Network reset (this removes saved Wi-Fi passwords)."],
    macos: ["Click the Wi-Fi icon in the menu bar, turn Wi-Fi off and on, then choose your network.", "If it will not connect: System Settings > Wi-Fi > your network > Forget This Network, then join again with the password."],
    android: ["Swipe down, turn Wi-Fi off and on, then pick your network.", "If it will not connect: Settings > Wi-Fi > your network > Forget, then join again."],
    iphone: ["Open Control Center, turn Wi-Fi off and on.", "If it will not connect: Settings > Wi-Fi > (i) next to your network > Forget This Network, then join again."],
    router: ["Check the router is powered on and its Wi-Fi light is on.", COMMON.restart_router],
  },
  no_internet: {
    all: [COMMON.other_device, COMMON.isp_status],
    windows: ["Restart the computer once to clear a stuck connection."],
    macos: ["Restart the Mac once to clear a stuck connection."],
    android: ["Turn Wi-Fi off and use mobile data to confirm the phone itself can reach the internet."],
    iphone: ["Turn Wi-Fi off and use mobile data to confirm the phone itself can reach the internet."],
    router: [COMMON.restart_router, "Check the cable from the wall (fibre, DSL or cable) to the modem is firmly connected.", COMMON.isp_call],
  },
  dns_problem: {
    all: ["Most DNS problems clear after restarting the router, which refreshes its DNS settings."],
    windows: ["Open Command Prompt and run: ipconfig /flushdns", "To use a public DNS: Settings > Network & internet > your connection > DNS server assignment > Edit > Manual, IPv4 preferred 1.1.1.1, alternate 8.8.8.8. Switch back to Automatic to undo."],
    macos: ["System Settings > Wi-Fi > Details next to your network > DNS. Add 1.1.1.1 and 8.8.8.8. Remove them to undo."],
    android: ["Settings > Network & internet > Private DNS > Private DNS provider hostname: one.one.one.one. Choose Automatic to undo. (Menu names vary by phone maker.)"],
    iphone: ["Settings > Wi-Fi > (i) next to your network > Configure DNS > Manual, add 1.1.1.1. Choose Automatic to undo."],
    router: [COMMON.restart_router, "If it keeps happening, set the router's DNS servers to 1.1.1.1 and 8.8.8.8 in its admin page (address is usually on a label on the router)."],
  },
  unstable: {
    all: ["Move closer to the router, or remove walls and metal objects between you and it.", "Pause big downloads, video streams and cloud backups on other devices, then test again."],
    windows: ["Plug in an Ethernet cable if you can. If the problem disappears, it is the Wi-Fi signal."],
    macos: ["Plug in an Ethernet adapter if you can. If the problem disappears, it is the Wi-Fi signal."],
    android: ["If your router shows two networks (2.4 GHz and 5 GHz), use 5 GHz near the router and 2.4 GHz far away."],
    iphone: ["If your router shows two networks (2.4 GHz and 5 GHz), use 5 GHz near the router and 2.4 GHz far away."],
    router: [COMMON.restart_router, "Place the router high and central, not in a cupboard or near a microwave.", "If drops continue on every device even with a cable, contact your internet provider: the line itself may be faulty."],
  },
  slow: {
    all: ["Pause downloads, streaming and backups on other devices, then run the checkup again.", "Run the checkup near the router, then where it is slow. A big difference means weak Wi-Fi coverage."],
    windows: ["Close VPN apps and test again; a VPN adds delay."],
    macos: ["Close VPN apps and test again; a VPN adds delay."],
    android: ["Turn off battery saver and any VPN app, then test again."],
    iphone: ["Turn off Low Data Mode (Settings > Wi-Fi > (i) > Low Data Mode) and any VPN, then test again."],
    router: [COMMON.restart_router, "If it is slow on every device even near the router, compare with your plan and contact your internet provider."],
  },
  slow_setup: {
    all: ["Slow first connections are usually slow DNS. Follow the DNS steps for your device."],
    windows: ["Open Command Prompt and run: ipconfig /flushdns"],
    macos: ["Restart the Mac to clear its DNS cache."],
    android: ["Turn Wi-Fi off and on to refresh DNS."],
    iphone: ["Turn Wi-Fi off and on to refresh DNS."],
    router: [COMMON.restart_router],
  },
  site_no_answer: {
    all: ["Try the website on mobile data. If it works there, your network or provider is blocking or failing to reach it.", "Search for the website's name plus \"down\" or check its official status page from another connection.", "If you use a VPN, ad blocker or parental-control DNS, turn it off briefly and try again."],
    windows: ["Open Command Prompt and run: ipconfig /flushdns, then try again."],
    macos: ["Restart the browser, then try again."],
    android: ["Clear the browser cache for that site, then try again."],
    iphone: ["Settings > Safari > Clear History and Website Data only if other steps fail (this signs you out of sites)."],
    router: ["Check the router's parental controls or blocked-sites list for this website."],
  },
  site_not_found: {
    all: ["Check the spelling of the address.", "Search for the organisation's name to find its correct website address."],
    windows: [], macos: [], android: [], iphone: [], router: [],
  },
};

/** The specialist's closing line. */
export const CLOSING = "If this does not help, run the checkup again and tell me what changed.";

/**
 * Languages the playbooks are written in. Each entry has the language's own name, for the
 * page's menu, and its playbooks, labels and closing line.
 */
export const LANGUAGES = {
  en: { name: "English", playbooks: PLAYBOOKS, labels: { problems: PROBLEMS, devices: DEVICES }, closing: CLOSING },
  hi: { name: "हिन्दी (Hindi)", playbooks: hindi.PLAYBOOKS, labels: hindi.LABELS, closing: hindi.CLOSING },
  ta: { name: "தமிழ் (Tamil)", playbooks: tamil.PLAYBOOKS, labels: tamil.LABELS, closing: tamil.CLOSING },
};

/**
 * Return the steps for one problem and device, general steps first. Pure.
 *
 * :param problem: A key of PROBLEMS.
 * :param device: A key of DEVICES.
 * :param language: A key of LANGUAGES; English when left out.
 * :return: {problem, device, language, steps, closing}.
 */
export function stepsFor(problem, device, language = "en") {
  const lang = LANGUAGES[language];
  const book = lang.playbooks[problem];
  return {
    problem: lang.labels.problems[problem],
    device: lang.labels.devices[device],
    language: language,
    steps: [...book.all, ...(book[device] || [])],
    closing: lang.closing,
  };
}
