const { expect } = require("chai");
const { ethers } = require("hardhat");

// OwnerType enum: HUMAN = 0, AGENT = 1 (mirrors VoicescapeRegistry.OwnerType)
const HUMAN = 0;
const AGENT = 1;

describe("VoicescapeRegistry", function () {
  let registry;

  beforeEach(async function () {
    const Registry = await ethers.getContractFactory("VoicescapeRegistry");
    registry = await Registry.deploy();
    await registry.waitForDeployment();
  });

  it("registers a page and resolves it", async function () {
    const [owner] = await ethers.getSigners();
    await registry.registerPage("Brandon", "QmHash123", HUMAN, ethers.ZeroAddress, "");
    const [resolvedOwner, hash, ownerType, operator, purpose] =
      await registry.resolvePage("brandon");
    expect(resolvedOwner).to.equal(owner.address);
    expect(hash).to.equal("QmHash123");
    expect(ownerType).to.equal(HUMAN);
    expect(operator).to.equal(ethers.ZeroAddress);
    expect(purpose).to.equal("");
  });

  it("normalizes usernames to lowercase", async function () {
    await registry.registerPage("CRYPTO_fan-99", "QmX", HUMAN, ethers.ZeroAddress, "");
    expect(await registry.usernameExists("crypto_fan-99")).to.equal(true);
    expect(await registry.usernameExists("CRYPTO_FAN-99")).to.equal(true);
  });

  it("reverts when registering a taken username (any casing)", async function () {
    await registry.registerPage("alice", "QmA", HUMAN, ethers.ZeroAddress, "");
    await expect(
      registry.registerPage("ALICE", "QmB", HUMAN, ethers.ZeroAddress, "")
    ).to.be.revertedWithCustomError(registry, "UsernameTaken");
  });

  it("reverts on invalid usernames", async function () {
    // too short
    await expect(
      registry.registerPage("ab", "Qm", HUMAN, ethers.ZeroAddress, "")
    ).to.be.revertedWithCustomError(registry, "UsernameInvalid");
    // bad chars
    await expect(
      registry.registerPage("not a name!", "Qm", HUMAN, ethers.ZeroAddress, "")
    ).to.be.revertedWithCustomError(registry, "UsernameInvalid");
    // too long (33 chars)
    await expect(
      registry.registerPage("a".repeat(33), "Qm", HUMAN, ethers.ZeroAddress, "")
    ).to.be.revertedWithCustomError(registry, "UsernameInvalid");
  });

  it("only the page owner can update", async function () {
    const [, other] = await ethers.getSigners();
    await registry.registerPage("alice", "QmOld", HUMAN, ethers.ZeroAddress, "");
    await expect(
      registry.connect(other).updatePage("alice", "QmNew")
    ).to.be.revertedWithCustomError(registry, "NotPageOwner");
    await registry.updatePage("ALICE", "QmNew");
    const [, hash] = await registry.resolvePage("alice");
    expect(hash).to.equal("QmNew");
  });

  // ---------- Phase B: human/agent distinction ----------

  it("registers an agent page with operator and purpose disclosure", async function () {
    const [, operator] = await ethers.getSigners();
    await registry.registerPage(
      "AgentSmith",
      "QmAgent",
      AGENT,
      operator.address,
      "Autonomous research assistant"
    );
    const [resolvedOwner, hash, ownerType, resolvedOperator, purpose] =
      await registry.resolvePage("agentsmith");
    expect(hash).to.equal("QmAgent");
    expect(ownerType).to.equal(AGENT);
    expect(resolvedOperator).to.equal(operator.address);
    expect(purpose).to.equal("Autonomous research assistant");
  });

  it("reverts an agent registration without an operator address", async function () {
    await expect(
      registry.registerPage("agentx", "QmA", AGENT, ethers.ZeroAddress, "does things")
    ).to.be.revertedWithCustomError(registry, "DisclosureRequired");
  });

  it("reverts an agent registration without a purpose", async function () {
    const [, operator] = await ethers.getSigners();
    await expect(
      registry.registerPage("agenty", "QmA", AGENT, operator.address, "")
    ).to.be.revertedWithCustomError(registry, "DisclosureRequired");
  });

  it("registers a human page without operator or purpose", async function () {
    await registry.registerPage("humanbob", "QmH", HUMAN, ethers.ZeroAddress, "");
    const [, , ownerType, operator, purpose] = await registry.resolvePage("humanbob");
    expect(ownerType).to.equal(HUMAN);
    expect(operator).to.equal(ethers.ZeroAddress);
    expect(purpose).to.equal("");
  });

  it("ownerType is immutable: updatePage cannot change it", async function () {
    const [, operator] = await ethers.getSigners();

    // human stays human after an update
    await registry.registerPage("humanbob", "QmH", HUMAN, ethers.ZeroAddress, "");
    await registry.updatePage("humanbob", "QmH2");
    let [, , ownerType, , ] = await registry.resolvePage("humanbob");
    expect(ownerType).to.equal(HUMAN);

    // agent keeps ownerType, operator and purpose after an update
    await registry.registerPage(
      "agentone",
      "QmA1",
      AGENT,
      operator.address,
      "trading bot"
    );
    await registry.updatePage("agentone", "QmA2");
    const [, hash, ownerType2, resolvedOperator, purpose] =
      await registry.resolvePage("agentone");
    expect(hash).to.equal("QmA2");
    expect(ownerType2).to.equal(AGENT);
    expect(resolvedOperator).to.equal(operator.address);
    expect(purpose).to.equal("trading bot");
  });

  it("resolvePage returns all five fields for both page kinds", async function () {
    const [owner, operator] = await ethers.getSigners();
    await registry.registerPage("humanbob", "QmH", HUMAN, ethers.ZeroAddress, "");
    await registry.registerPage(
      "agentone",
      "QmA",
      AGENT,
      operator.address,
      "scout"
    );

    const human = await registry.resolvePage("HUMANBOB");
    expect(human.owner).to.equal(owner.address);
    expect(human.ipfsHash).to.equal("QmH");
    expect(human.ownerType).to.equal(HUMAN);
    expect(human.operator).to.equal(ethers.ZeroAddress);
    expect(human.purpose).to.equal("");

    const agent = await registry.resolvePage("AGENTONE");
    expect(agent.owner).to.equal(owner.address);
    expect(agent.ipfsHash).to.equal("QmA");
    expect(agent.ownerType).to.equal(AGENT);
    expect(agent.operator).to.equal(operator.address);
    expect(agent.purpose).to.equal("scout");
  });

  it("emits ownerType, operator and purpose in PageRegistered", async function () {
    const [, operator] = await ethers.getSigners();
    await expect(
      registry.registerPage(
        "agentone",
        "QmA",
        AGENT,
        operator.address,
        "scout"
      )
    )
      .to.emit(registry, "PageRegistered")
      .withArgs(
        "agentone",
        (await ethers.getSigners())[0].address,
        "QmA",
        AGENT,
        operator.address,
        "scout"
      );
  });

  it("emits ownerType, operator and purpose in PageUpdated", async function () {
    const [, operator] = await ethers.getSigners();
    await registry.registerPage(
      "agentone",
      "QmA",
      AGENT,
      operator.address,
      "scout"
    );
    await expect(registry.updatePage("agentone", "QmA2"))
      .to.emit(registry, "PageUpdated")
      .withArgs(
        "agentone",
        (await ethers.getSigners())[0].address,
        "QmA2",
        AGENT,
        operator.address,
        "scout"
      );
  });
});

describe("VoicescapeTips", function () {
  let registry, tips, owner, tipper, treasury;

  beforeEach(async function () {
    [owner, tipper, treasury] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("VoicescapeRegistry");
    registry = await Registry.deploy();
    await registry.waitForDeployment();

    const Tips = await ethers.getContractFactory("VoicescapeTips");
    tips = await Tips.deploy(await registry.getAddress(), treasury.address);
    await tips.waitForDeployment();
  });

  it("splits a tip 98/2 between page owner and treasury", async function () {
    await registry.connect(owner).registerPage("alice", "QmA", HUMAN, ethers.ZeroAddress, "");

    const ownerBefore = await ethers.provider.getBalance(owner.address);
    const treasuryBefore = await ethers.provider.getBalance(treasury.address);

    const amount = ethers.parseEther("1.0");
    await expect(tips.connect(tipper).tipPage("alice", { value: amount }))
      .to.emit(tips, "TipSent")
      .withArgs(
        "alice",
        tipper.address,
        owner.address,
        amount,
        (amount * 200n) / 10000n // 2% fee
      );

    const ownerAfter = await ethers.provider.getBalance(owner.address);
    const treasuryAfter = await ethers.provider.getBalance(treasury.address);

    expect(ownerAfter - ownerBefore).to.equal((amount * 98n) / 100n);
    expect(treasuryAfter - treasuryBefore).to.equal((amount * 2n) / 100n);
  });

  it("reverts on a zero-value tip", async function () {
    await registry.connect(owner).registerPage("alice", "QmA", HUMAN, ethers.ZeroAddress, "");
    await expect(
      tips.connect(tipper).tipPage("alice", { value: 0 })
    ).to.be.revertedWithCustomError(tips, "ZeroTip");
  });

  it("reverts when tipping an unknown username", async function () {
    await expect(
      tips.connect(tipper).tipPage("nobody", {
        value: ethers.parseEther("0.1"),
      })
    ).to.be.revertedWithCustomError(registry, "UsernameInvalid");
  });

  it("only owner can change treasury", async function () {
    const [, , , stranger] = await ethers.getSigners();
    await expect(
      tips.connect(stranger).setTreasury(stranger.address)
    ).to.be.revertedWithCustomError(tips, "NotOwner");
    await tips.setTreasury(stranger.address);
    expect(await tips.treasury()).to.equal(stranger.address);
  });
});

describe("VoicescapeTips.buyListing (direct atomic sale — no escrow)", function () {
  let registry, tips, owner, buyer, seller, treasury;

  beforeEach(async function () {
    [owner, buyer, seller, treasury] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("VoicescapeRegistry");
    registry = await Registry.deploy();
    await registry.waitForDeployment();

    const Tips = await ethers.getContractFactory("VoicescapeTips");
    tips = await Tips.deploy(await registry.getAddress(), treasury.address);
    await tips.waitForDeployment();
  });

  it("splits a purchase 98/2 to seller and treasury atomically", async function () {
    const sellerBefore = await ethers.provider.getBalance(seller.address);
    const treasuryBefore = await ethers.provider.getBalance(treasury.address);

    const amount = ethers.parseEther("1.0");
    await expect(
      tips.connect(buyer).buyListing(seller.address, "listing-42", { value: amount })
    )
      .to.emit(tips, "PurchaseCompleted")
      .withArgs(buyer.address, seller.address, "listing-42", amount, (amount * 200n) / 10000n);

    const sellerAfter = await ethers.provider.getBalance(seller.address);
    const treasuryAfter = await ethers.provider.getBalance(treasury.address);

    expect(sellerAfter - sellerBefore).to.equal((amount * 98n) / 100n);
    expect(treasuryAfter - treasuryBefore).to.equal((amount * 2n) / 100n);
    // The contract never holds funds: its balance is zero after the sale.
    expect(await ethers.provider.getBalance(await tips.getAddress())).to.equal(0n);
  });

  it("handles odd amounts: the fee rounds down, seller keeps the dust", async function () {
    // 1 wei: fee = 1*200/10000 = 0, seller gets the whole wei.
    await expect(
      tips.connect(buyer).buyListing(seller.address, "odd", { value: 1n })
    ).to.emit(tips, "PurchaseCompleted");
    expect(await ethers.provider.getBalance(await tips.getAddress())).to.equal(0n);
  });

  it("reverts on a zero-value purchase", async function () {
    await expect(
      tips.connect(buyer).buyListing(seller.address, "listing-1", { value: 0 })
    ).to.be.revertedWithCustomError(tips, "ZeroPurchase");
  });

  it("reverts on a zero-address seller", async function () {
    await expect(
      tips.connect(buyer).buyListing(ethers.ZeroAddress, "listing-1", {
        value: ethers.parseEther("0.1"),
      })
    ).to.be.revertedWithCustomError(tips, "InvalidSeller");
  });
});
