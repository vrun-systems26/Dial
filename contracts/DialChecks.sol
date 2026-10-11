// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title DialChecks
/// @notice On-chain "checks" for Dial. A sender locks stablecoin for a receiver.
///         The receiver cashes it by revealing the claim secret (paying a cash-out shop in the
///         same step), or, once it expires unclaimed, anyone can trigger the refund to the sender.
/// @dev    claimHash = keccak256(abi.encodePacked(claimSecret)). The 32-byte secret stays off-chain
///         until cashing, so the check can't be claimed by guessing. `ref` is a public random id
///         the off-chain service uses to re-derive the secret and the 6-digit code.
contract DialChecks {
    enum Status { None, Open, Cashed, Refunded }

    struct Check {
        address sender;
        uint96 amount;
        address receiver;
        uint40 expiresAt;
        Status status;
        bytes32 ref;
        bytes32 claimHash;
    }

    IERC20 public immutable token;
    uint256 public nextId = 1;
    mapping(uint256 => Check) public checks;

    event CheckCreated(uint256 indexed id, address indexed sender, address indexed receiver, uint256 amount, uint256 expiresAt, bytes32 ref);
    event CheckCashed(uint256 indexed id, address indexed receiver, address indexed paidTo, uint256 amount);
    event CheckRefunded(uint256 indexed id, address indexed sender, uint256 amount);

    constructor(IERC20 _token) {
        token = _token;
    }

    /// @notice Lock `amount` for `receiver`. Sender must approve this contract first.
    function createCheck(address receiver, uint96 amount, uint40 ttlSeconds, bytes32 ref, bytes32 claimHash)
        public
        returns (uint256 id)
    {
        require(receiver != address(0) && amount > 0 && ttlSeconds > 0, "bad check");
        id = nextId++;
        uint40 expiresAt = uint40(block.timestamp) + ttlSeconds;
        checks[id] = Check(msg.sender, amount, receiver, expiresAt, Status.Open, ref, claimHash);
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        emit CheckCreated(id, msg.sender, receiver, amount, expiresAt, ref);
    }

    /// @notice Bulk payouts (e.g. an NGO paying hundreds of families in one transaction).
    function createChecks(
        address[] calldata receivers,
        uint96[] calldata amounts,
        uint40 ttlSeconds,
        bytes32[] calldata refs,
        bytes32[] calldata claimHashes
    ) external returns (uint256 firstId) {
        uint256 n = receivers.length;
        require(amounts.length == n && refs.length == n && claimHashes.length == n, "length mismatch");
        firstId = nextId;
        for (uint256 i = 0; i < n; i++) {
            createCheck(receivers[i], amounts[i], ttlSeconds, refs[i], claimHashes[i]);
        }
    }

    /// @notice Receiver cashes the check. Funds go to `payTo`
    ///         (a cash-out shop, or the receiver's own address to keep it in dollars).
    function cashCheck(uint256 id, bytes32 claimSecret, address payTo) external {
        Check storage c = checks[id];
        require(c.status == Status.Open, "not open");
        require(msg.sender == c.receiver, "not receiver");
        require(block.timestamp < c.expiresAt, "expired");
        require(keccak256(abi.encodePacked(claimSecret)) == c.claimHash, "wrong secret");
        c.status = Status.Cashed;
        require(token.transfer(payTo, c.amount), "transfer failed");
        emit CheckCashed(id, c.receiver, payTo, c.amount);
    }

    /// @notice After expiry, anyone (e.g. the agent's background job) can return the money to the sender.
    function refund(uint256 id) external {
        Check storage c = checks[id];
        require(c.status == Status.Open, "not open");
        require(block.timestamp >= c.expiresAt, "not expired");
        c.status = Status.Refunded;
        require(token.transfer(c.sender, c.amount), "transfer failed");
        emit CheckRefunded(id, c.sender, c.amount);
    }
}
