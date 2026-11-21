// Registers this website's operations with the agent runtime.
// agent-manifest.json loads this module through "actions.module". Only the names in
// "actions.agentTools" become model tools, called website_<name>.
//
// TODO: import the class the page script exports, as site.js does, and wrap its
// operations here. Do not copy their business rules into this file.
// Operations return {ok: false, reason, field} when they refuse input, before changing
// anything, and throw only on unexpected failures. A throw is reported as "unknown".
// Import the page script by the same URL the page uses (no ?v= query), or the actions
// get a second, separate copy of the page state. On a site with several modules, import
// the module that keeps the page object.
import { App } from "./script.js";

/**
 * Describes the site's operations as actions the agents can call.
 *
 * Each action wraps a function the page already uses, so the assistant and the manual
 * UI share one set of rules. The runtime validates arguments against inputSchema before
 * execute runs, and asks the visitor to confirm "irreversible" actions first.
 */
class SiteActions {
  /**
   * Register every site action with the runtime.
   *
   * :param actions: The runtime registry facade with a register(definition) method.
   */
  static registerActions(actions) {
    actions.register(SiteActions.readStateAction());
    actions.register(SiteActions.addItemAction());
    actions.register(SiteActions.submitOrderAction());
  }

  /**
   * Describe the read action that returns the page's data and current state.
   *
   * :return: The action definition.
   */
  static readStateAction() {
    return {
      name: "get_site_state",
      description: "TODO: Read the actual <catalog>, <current selection/cart>, its version and the latest <order/request> on this page.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: SiteActions.readState,
    };
  }

  /**
   * Return a fresh copy of the page state.
   *
   * :return: The page state as plain JSON data.
   */
  static readState() {
    return App.page.getState();
  }

  /**
   * Describe a reversible write the agent may run without a confirmation dialog.
   *
   * :return: The action definition.
   */
  static addItemAction() {
    return {
      name: "add_item",
      description: "TODO: Add a quantity of one <item> to the visible <cart>, keeping existing items. Returns the updated state, or ok false with a reason. Does not place an order.",
      // "write" runs immediately. Use it only for changes the visitor can undo on the page.
      effect: "write",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id", "quantity"],
        properties: {
          // An enum of real IDs stops the model from inventing items.
          id: {
            type: "string",
            enum: App.page.catalogIds(),
            description: "TODO: Item id from website_get_site_state.",
          },
          quantity: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "TODO: How many to add.",
          },
        },
      },
      execute: SiteActions.addItem,
    };
  }

  /**
   * Add an item through the site's own cart function.
   *
   * :param args: The validated arguments with id and quantity.
   * :return: The updated page state, which becomes the tool receipt.
   */
  static addItem(args) {
    return App.page.addItem(args.id, args.quantity);
  }

  /**
   * Describe the irreversible operation that the visitor must confirm.
   *
   * :return: The action definition.
   */
  static submitOrderAction() {
    return {
      name: "submit_order",
      description: "TODO: Place the <order> for the current <cart>. The browser asks the visitor to confirm first. The site refuses a stale expectedVersion. Returns the receipt.",
      // "irreversible" makes the runtime open a confirmation dialog before execute runs.
      effect: "irreversible",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["customerName", "expectedVersion"],
        properties: {
          customerName: {
            type: "string",
            minLength: 1,
            maxLength: 80,
            description: "TODO: The name the visitor gave.",
          },
          expectedVersion: {
            type: "integer",
            minimum: 0,
            description: "TODO: version from website_get_site_state, read in this turn.",
          },
        },
      },
      execute: SiteActions.submitOrder,
    };
  }

  /**
   * Submit through the same function the page's own form uses.
   *
   * :param args: The validated, visitor-confirmed arguments.
   * :return: The order receipt, or {ok: false, reason} when the site refuses the order.
   * :raises Error: Only on an unexpected failure; the runtime then reports "unknown".
   */
  static submitOrder(args) {
    return App.page.submitOrder(args);
  }
}

// The runtime calls the module's registerActions export.
export const registerActions = SiteActions.registerActions;
