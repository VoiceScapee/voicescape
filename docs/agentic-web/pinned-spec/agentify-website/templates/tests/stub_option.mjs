import { StubElement } from "./stub_element.mjs";

/**
 * A stand-in for the browser's Option constructor, so page code that runs
 * new Option(text, value) can be imported under Node.
 *
 * Set globalThis.Option to this class before the page script loads.
 */
export class StubOption extends StubElement {
  /**
   * Create an option element.
   *
   * :param text: The option's label.
   * :param value: The option's value.
   */
  constructor(text, value) {
    super("option");
    this.textContent = text;
    this.value = value;
  }
}
