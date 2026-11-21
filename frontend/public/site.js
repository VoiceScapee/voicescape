// Mounts the assistant inside the /intros page. Load it with:
//   <script type="module" src="/site.js"></script>
// The page needs the mount markup from the assistant section in
// frontend/app/intros/page.tsx (ids #assistant-status and #agent-app).
// Live-URL mode: the actions module is imported by the same URL the page
// uses (no ?v= query), so reviewDetails() shares one copy of the checks
// with the actions the runtime loads.
import { checks } from "./site-actions.js";

/**
 * Boots the browser runtime in the page's assistant section.
 *
 * It points the runtime at this folder, so the manifest, network and actions load from
 * the same place as the page. Before each irreversible action, it shows its own
 * confirmation dialog, written for the visitor.
 */
export class AssistantMount {
  /**
   * The first chat message once the visitor has a key: what the assistant can do here.
   */
  static GREETING = "Ask me who's here, what they do, and whether their tipping is real — or tip someone. Every fact I give you comes from the site or the chain, and I'll show you the receipt.";

  /**
   * The confirmation dialog's words for each irreversible action. Name each button after
   * what it does, so that "Cancel" never has two meanings.
   */
  static DIALOGS = {
    "prepare_tip": {
      title: "Send this tip?",
      sentence: "Your wallet will sign one tip on Hedera mainnet. The contract splits it 98 percent to the page owner and 2 percent to the platform in the same transaction.",
      confirm: "Sign and send the tip",
      decline: "Don't send it",
    },
    "prepare_claim": {
      title: "Claim this blockpage name?",
      sentence: "This prepares a claim for the name below. You will open an approval link, review the preview, and sign once with your own wallet — one tiny Hedera gas fee.",
      confirm: "Prepare the claim",
      decline: "Don't claim it",
    },
    "post_intro": {
      title: "Publish this intro?",
      sentence: "This posts your introduction on the public board, under the handle below, with no edit or delete. Save the claim code it returns to link the intro after claiming a blockpage.",
      confirm: "Publish the intro",
      decline: "Don't publish it",
    },
  };

  /**
   * Boot the runtime and report the result in the status line.
   *
   * :return: The runtime engine, or null when boot failed.
   */
  static async start() {
    const status = document.querySelector("#assistant-status");
    const siteBase = new URL("./", import.meta.url).href;
    try {
      // Load the runtime here, so a missing or broken runtime is reported too.
      const { boot } = await import("./runtime/index.js");
      const booted = await boot("#agent-app", {
        originUrl: siteBase,
        sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", siteBase).href,
      });
      AssistantMount.engine = booted.engine;
      AssistantMount.defaultReview = booted.engine.onActionConfirm;
      booted.engine.onActionConfirm = AssistantMount.review;
      // Without a key the chat cannot answer yet. This is the same test as the
      // runtime's "API key required" badge in runtime/ui.js.
      const needsKey = !booted.engine.mockLLM
        && (!booted.engine.byokKey || booted.engine.byokKey === "demo");
      status.textContent = needsKey
        ? "Assistant needs your LLM API key. Add it in the settings below."
        : "Assistant connected to this page.";
      if (!needsKey) {
        AssistantMount.greet();
      }
      return booted.engine;
    } catch (error) {
      // The page must keep working without the assistant.
      status.textContent = "The assistant could not load. You can still use the page directly.";
      console.error("Assistant startup failed", error);
      return null;
    }
  }

  /**
   * Replace the runtime's general first chat message with GREETING. "New chat" keeps the
   * first message, so the greeting stays for the whole visit.
   */
  static greet() {
    const first = document.querySelector("#ns-msgs .ns-msg.bot");
    if (first) {
      first.textContent = AssistantMount.GREETING;
    }
  }

  /**
   * Ask the visitor to confirm actions before they run. One action listed in DIALOGS
   * gets this page's dialog, and anything else gets the runtime's own dialog.
   *
   * :param items: The actions waiting for confirmation, each with action, origin, effect
   *   and arguments.
   * :return: True when the visitor confirms.
   * :raises Error: The site's reason, when its own check refuses the action.
   */
  static async review(items) {
    let confirmed = false;
    if (items.length === 1 && Object.hasOwn(AssistantMount.DIALOGS, items[0].action)) {
      const content = await AssistantMount.dialogContent(items[0]);
      if (content.refusal) {
        // A dialog would offer a button that cannot work. The runtime runs nothing
        // and gives the agent this reason as an "Error from tool" message.
        throw new Error(content.refusal);
      }
      confirmed = await new Promise(AssistantMount.openDialog.bind(null, content));
    } else {
      confirmed = await AssistantMount.defaultReview(items);
    }
    AssistantMount.keepFocusInChat();
    return confirmed;
  }

  /**
   * Work out what the dialog says for one action: its words from DIALOGS, the readable
   * details and the exact call. This is plain data, so tests can check it.
   *
   * :param item: An action waiting for confirmation, with action, origin, effect
   *   and arguments.
   * :return: The title, sentence, button labels, details, exact call text and the
   *   site's refusal, if any.
   */
  static async dialogContent(item) {
    let details = {};
    try {
      details = (await AssistantMount.reviewDetails(item.action, item.arguments)) || {};
    } catch (error) {
      // The dialog then opens the exact call, and the visitor decides.
      console.error("Could not add details to the confirmation dialog", error);
    }
    return {
      ...AssistantMount.DIALOGS[item.action],
      details: details,
      refusal: details.refusal,
      exact: `${item.action} on ${item.origin} (${item.effect})\n${JSON.stringify(item.arguments, null, 2)}`,
    };
  }

  /**
   * Give the readable details of one irreversible action from the page's own
   * read-only operations, so no rule is copied here. When the operation's own
   * check refuses the call, return {refusal: reason}, and review() opens no dialog.
   * The checks are the same ones execute() runs, so the dialog and the operation
   * refuse a call for the same reason.
   *
   * :param action: The action name.
   * :param args: The action's arguments.
   * :return: Details by label, {refusal: reason}, or {} when the action has none.
   */
  static async reviewDetails(action, args) {
    if (action === "prepare_tip") {
      const check = await checks.checkTip(args);
      if (!check.ok) {
        return { refusal: check.reason };
      }
      return {
        "Recipient": check.username,
        "Amount": `${check.amountHbar} HBAR`,
        "Creator receives (98%)": `${check.creatorNetHbar} HBAR`,
        "Treasury fee (2%)": `${check.treasuryFeeHbar} HBAR`,
        "Estimated network fee": `${check.estNetworkFeeHbar} HBAR`,
        "Your wallet will sign": "One tipPage call on the Tips contract. The split happens in the same transaction; the platform never holds the funds.",
      };
    }
    if (action === "prepare_claim") {
      const check = await checks.checkClaim(args);
      if (!check.ok) {
        return { refusal: check.reason };
      }
      return {
        "Name": check.username,
        "Claim fee": "One tiny Hedera gas fee, paid when you sign on the approval link.",
        "Link expires": "24 hours. Nothing is pinned and no transaction is built until you tap approve on the link.",
      };
    }
    if (action === "post_intro") {
      const check = checks.checkIntro(args);
      if (!check.ok) {
        return { refusal: check.reason };
      }
      return {
        "Handle": check.handle,
        "Intro text": check.text,
        "Publishes as": "Public on /intros, unverified until linked to a claimed blockpage. No edit or delete; 365-day lifetime.",
      };
    }
    return {};
  }

  /**
   * Open the confirmation dialog: a question, a plain sentence, the readable details,
   * the exact call under "Technical details", and two buttons.
   *
   * :param content: What the dialog says, from dialogContent().
   * :param resolve: Receives true when the visitor confirms, and false otherwise.
   */
  static openDialog(content, resolve) {
    const dialog = document.createElement("dialog");
    dialog.className = "assistant-review";
    dialog.setAttribute("aria-labelledby", "assistant-review-title");
    const heading = document.createElement("h2");
    heading.id = "assistant-review-title";
    heading.textContent = content.title;
    // Start on the heading, which Enter cannot activate, so a stray Enter confirms nothing.
    heading.tabIndex = -1;
    heading.autofocus = true;
    const sentence = document.createElement("p");
    sentence.textContent = content.sentence;
    dialog.append(heading, sentence);
    const exact = document.createElement("details");
    const exactLabel = document.createElement("summary");
    exactLabel.textContent = "Technical details";
    const exactText = document.createElement("pre");
    exactText.textContent = content.exact;
    exact.append(exactLabel, exactText);
    const entries = Object.entries(content.details);
    if (entries.length) {
      const list = document.createElement("dl");
      for (const [label, value] of entries) {
        const term = document.createElement("dt");
        term.textContent = label;
        const description = document.createElement("dd");
        description.textContent = String(value);
        list.append(term, description);
      }
      dialog.append(list);
    } else {
      // Without readable details, open the exact call, so the visitor still sees it.
      exact.open = true;
    }
    const confirmButton = document.createElement("button");
    confirmButton.textContent = content.confirm;
    confirmButton.addEventListener("click", dialog.close.bind(dialog, "confirm"));
    const declineButton = document.createElement("button");
    declineButton.className = "assistant-decline";
    declineButton.textContent = content.decline;
    declineButton.addEventListener("click", dialog.close.bind(dialog, "decline"));
    // Escape also closes the dialog, without "confirm".
    dialog.addEventListener("close", AssistantMount.finishDialog.bind(null, dialog, resolve));
    dialog.append(exact, confirmButton, declineButton);
    document.body.append(dialog);
    dialog.showModal();
  }

  /**
   * Remove the closed dialog and report the visitor's choice.
   *
   * :param dialog: The dialog that just closed.
   * :param resolve: Receives true when the visitor pressed the confirm button.
   */
  static finishDialog(dialog, resolve) {
    dialog.remove();
    resolve(dialog.returnValue === "confirm");
  }

  /**
   * Put focus back in the chat input when a dialog left it on the page body. A chat form
   * disables its controls when it is sent, so focus can fall to the body, and the next
   * Tab would start at the top of the page.
   */
  static keepFocusInChat() {
    if (document.activeElement === document.body || document.activeElement === null) {
      document.querySelector("#ns-input")?.focus();
    }
  }
}

// Boot only in a browser. Node tests import this file to check the dialog's words.
if (typeof window !== "undefined") {
  await AssistantMount.start();
}
