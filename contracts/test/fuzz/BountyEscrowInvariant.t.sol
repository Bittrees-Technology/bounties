// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {BountyEscrow} from "../../src/BountyEscrow.sol";
import {IBountyEscrow} from "../../src/IBountyEscrow.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract BountyEscrowHandler is Test {
    struct TrackedBounty {
        uint256 id;
        address token;
        address provider;
        uint256 amount;
        uint64 deadline;
        bytes32 scopeHash;
        bytes32 proposalHash;
        bytes32 termsHash;
    }

    BountyEscrow public immutable escrow;
    MockERC20 public immutable tokenA;
    MockERC20 public immutable tokenB;
    address public immutable requester;
    address public immutable provider;

    TrackedBounty[] internal _tracked;

    bytes32 internal constant METADATA_HASH = keccak256("invariant-metadata");
    bytes32 internal constant PROPOSAL_HASH = keccak256("invariant-proposal");

    constructor(BountyEscrow escrow_, MockERC20 tokenA_, MockERC20 tokenB_, address requester_, address provider_) {
        escrow = escrow_;
        tokenA = tokenA_;
        tokenB = tokenB_;
        requester = requester_;
        provider = provider_;
    }

    function trackedCount() external view returns (uint256) {
        return _tracked.length;
    }

    function trackedBounty(uint256 index)
        external
        view
        returns (uint256 id, address token, uint256 amount, uint64 deadline, IBountyEscrow.State state)
    {
        TrackedBounty storage tracked = _tracked[index];
        BountyEscrow.Bounty memory bounty = escrow.getBounty(tracked.id);
        return (tracked.id, tracked.token, tracked.amount, tracked.deadline, bounty.state);
    }

    function trackedProposalHash(uint256 index) external view returns (bytes32) {
        return _tracked[index].proposalHash;
    }

    function trackedTermsHash(uint256 index) external view returns (bytes32) {
        return _tracked[index].termsHash;
    }

    function createBounty(uint8 tokenChoice, uint96 rawAmount, uint32 rawDelay, bool fundedNow) external {
        if (_tracked.length >= 8) return;

        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint64 deadline = uint64(block.timestamp + bound(uint256(rawDelay), 1, 21 days));
        MockERC20 token = tokenChoice % 2 == 0 ? tokenA : tokenB;
        bytes32 proposalHash = bytes32(uint256(_tracked.length + 11));
        bytes32 scopeHash = _scopeHash(address(token), amount, deadline, bytes32(uint256(_tracked.length + 1)));
        bytes32 termsHash = _termsHash(scopeHash, proposalHash, provider);

        vm.prank(requester);
        uint256 id =
            escrow.createBounty(address(token), fundedNow ? amount : 0, deadline, scopeHash, provider, proposalHash);
        _tracked.push(
            TrackedBounty({
                id: id,
                token: address(token),
                provider: provider,
                amount: amount,
                deadline: deadline,
                scopeHash: scopeHash,
                proposalHash: proposalHash,
                termsHash: termsHash
            })
        );
    }

    function fund(uint256 rawIndex) external {
        if (_tracked.length == 0) return;
        uint256 index = rawIndex % _tracked.length;
        TrackedBounty storage tracked = _tracked[index];
        BountyEscrow.Bounty memory bounty = escrow.getBounty(tracked.id);
        if (bounty.state != IBountyEscrow.State.Created) return;
        if (tracked.deadline != 0 && block.timestamp >= tracked.deadline) return;

        vm.prank(requester);
        escrow.fundBounty(tracked.id, tracked.amount);
    }

    function accept(uint256 rawIndex) external {
        if (_tracked.length == 0) return;
        uint256 index = rawIndex % _tracked.length;
        TrackedBounty storage tracked = _tracked[index];
        BountyEscrow.Bounty memory bounty = escrow.getBounty(tracked.id);
        if (bounty.state != IBountyEscrow.State.Funded) return;
        if (tracked.deadline != 0 && block.timestamp >= tracked.deadline) return;

        vm.prank(tracked.provider);
        escrow.acceptBounty(tracked.id, tracked.termsHash);
    }

    function deliver(uint256 rawIndex) external {
        if (_tracked.length == 0) return;
        uint256 index = rawIndex % _tracked.length;
        TrackedBounty storage tracked = _tracked[index];
        BountyEscrow.Bounty memory bounty = escrow.getBounty(tracked.id);
        if (bounty.state != IBountyEscrow.State.ProviderAccepted) return;
        if (tracked.deadline != 0 && block.timestamp >= tracked.deadline) return;

        vm.prank(tracked.provider);
        escrow.submitDelivery(
            tracked.id,
            _evidenceHash(
                tracked.id,
                tracked.scopeHash,
                tracked.termsHash,
                tracked.provider,
                keccak256(abi.encode(tracked.id, index)),
                keccak256(abi.encode(tracked.amount, tracked.deadline)),
                bytes32(uint256(index + 101))
            )
        );
    }

    function approve(uint256 rawIndex) external {
        if (_tracked.length == 0) return;
        uint256 index = rawIndex % _tracked.length;
        TrackedBounty storage tracked = _tracked[index];
        BountyEscrow.Bounty memory bounty = escrow.getBounty(tracked.id);
        if (bounty.state != IBountyEscrow.State.Delivered) return;

        vm.prank(requester);
        escrow.approveDelivery(
            tracked.id, _approvalHash(tracked.id, bounty.evidenceHash, requester, bytes32(uint256(index + 201)))
        );
    }

    function release(uint256 rawIndex) external {
        if (_tracked.length == 0) return;
        uint256 index = rawIndex % _tracked.length;
        TrackedBounty storage tracked = _tracked[index];
        BountyEscrow.Bounty memory bounty = escrow.getBounty(tracked.id);
        if (
            bounty.state != IBountyEscrow.State.BuyerApproved
                && (bounty.state != IBountyEscrow.State.Delivered || block.timestamp < bounty.reviewDeadline)
        ) return;

        escrow.release(tracked.id);
    }

    function proposeSettlement(uint256 rawIndex, uint96 rawProviderPayout, bool providerProposes) external {
        if (_tracked.length == 0) return;
        uint256 index = rawIndex % _tracked.length;
        TrackedBounty storage tracked = _tracked[index];
        BountyEscrow.Bounty memory bounty = escrow.getBounty(tracked.id);
        if (
            bounty.state != IBountyEscrow.State.Funded && bounty.state != IBountyEscrow.State.ProviderAccepted
                && bounty.state != IBountyEscrow.State.Delivered
        ) return;
        if (
            ((bounty.state == IBountyEscrow.State.Funded || bounty.state == IBountyEscrow.State.ProviderAccepted)
                    && block.timestamp >= bounty.deliveryDeadline)
                || (bounty.state == IBountyEscrow.State.Delivered && block.timestamp >= bounty.reviewDeadline)
        ) return;

        uint256 providerPayout = bound(uint256(rawProviderPayout), 0, bounty.amount);
        vm.prank(providerProposes ? tracked.provider : requester);
        escrow.proposeSettlement(tracked.id, providerPayout);
    }

    function acceptSettlement(uint256 rawIndex) external {
        if (_tracked.length == 0) return;
        uint256 index = rawIndex % _tracked.length;
        TrackedBounty storage tracked = _tracked[index];
        BountyEscrow.Bounty memory bounty = escrow.getBounty(tracked.id);
        if (
            bounty.state != IBountyEscrow.State.Funded && bounty.state != IBountyEscrow.State.ProviderAccepted
                && bounty.state != IBountyEscrow.State.Delivered
        ) return;
        if (bounty.settlementProposer == address(0)) return;
        if (block.timestamp >= bounty.settlementProposalExpiry) return;

        address acceptor = bounty.settlementProposer == requester ? tracked.provider : requester;
        vm.prank(acceptor);
        escrow.acceptSettlement(tracked.id, bounty.proposedProviderPayout);
    }

    function cancelSettlementProposal(uint256 rawIndex) external {
        if (_tracked.length == 0) return;
        uint256 index = rawIndex % _tracked.length;
        TrackedBounty storage tracked = _tracked[index];
        BountyEscrow.Bounty memory bounty = escrow.getBounty(tracked.id);
        if (bounty.settlementProposer == address(0)) return;

        vm.prank(bounty.settlementProposer);
        escrow.cancelSettlementProposal(tracked.id);
    }

    function cancel(uint256 rawIndex) external {
        if (_tracked.length == 0) return;
        uint256 index = rawIndex % _tracked.length;
        TrackedBounty storage tracked = _tracked[index];
        BountyEscrow.Bounty memory bounty = escrow.getBounty(tracked.id);
        if (bounty.state != IBountyEscrow.State.Created) return;

        vm.prank(requester);
        escrow.cancelBounty(tracked.id);
    }

    function refund(uint256 rawIndex) external {
        if (_tracked.length == 0) return;
        uint256 index = rawIndex % _tracked.length;
        TrackedBounty storage tracked = _tracked[index];
        BountyEscrow.Bounty memory bounty = escrow.getBounty(tracked.id);
        if (bounty.state != IBountyEscrow.State.Funded && bounty.state != IBountyEscrow.State.ProviderAccepted) {
            return;
        }
        if (tracked.deadline == 0 || block.timestamp < tracked.deadline) return;

        vm.prank(requester);
        escrow.refundBounty(tracked.id);
    }

    function advanceTime(uint32 rawSeconds) external {
        vm.warp(block.timestamp + bound(uint256(rawSeconds), 1, 7 days));
    }

    function directTransfer(uint8 tokenChoice, uint96 rawAmount) external {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max / 4);
        MockERC20 token = tokenChoice % 2 == 0 ? tokenA : tokenB;
        vm.prank(requester);
        token.transfer(address(escrow), amount);
    }

    function _scopeHash(address token, uint256 amount, uint64 deadline, bytes32 salt) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("BOUNTY_SCOPE_V1"),
                block.chainid,
                address(escrow),
                requester,
                token,
                amount,
                deadline,
                METADATA_HASH,
                salt
            )
        );
    }

    function _termsHash(bytes32 scopeHash, bytes32 proposalHash, address selectedProvider)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                keccak256("BOUNTY_TERMS_V1"), block.chainid, address(escrow), scopeHash, proposalHash, selectedProvider
            )
        );
    }

    function _evidenceHash(
        uint256 bountyId,
        bytes32 scopeHash,
        bytes32 termsHash,
        address submittedBy,
        bytes32 contentHash,
        bytes32 uriHash,
        bytes32 salt
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("BOUNTY_EVIDENCE_V1"),
                block.chainid,
                address(escrow),
                bountyId,
                scopeHash,
                termsHash,
                submittedBy,
                contentHash,
                uriHash,
                salt
            )
        );
    }

    function _approvalHash(uint256 bountyId, bytes32 evidenceHash, address buyer, bytes32 salt)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                keccak256("BOUNTY_APPROVAL_V1"),
                block.chainid,
                address(escrow),
                bountyId,
                evidenceHash,
                buyer,
                keccak256("approved"),
                salt
            )
        );
    }
}

contract BountyEscrowInvariantTest is StdInvariant, Test {
    BountyEscrow internal escrow;
    MockERC20 internal tokenA;
    MockERC20 internal tokenB;
    BountyEscrowHandler internal handler;

    address internal requester = makeAddr("requester");
    address internal provider = makeAddr("provider");

    uint256 internal constant INITIAL_MINT = type(uint128).max;

    function setUp() public {
        escrow = new BountyEscrow();
        tokenA = new MockERC20();
        tokenB = new MockERC20();

        tokenA.mint(requester, INITIAL_MINT);
        tokenB.mint(requester, INITIAL_MINT);

        vm.startPrank(requester);
        tokenA.approve(address(escrow), type(uint256).max);
        tokenB.approve(address(escrow), type(uint256).max);
        vm.stopPrank();

        handler = new BountyEscrowHandler(escrow, tokenA, tokenB, requester, provider);
        handler.createBounty(0, 1_000 ether, 1 days, true);
        handler.createBounty(1, 750 ether, 2 days, false);
        handler.createBounty(0, 500 ether, 3 days, false);
        targetContract(address(handler));
    }

    function invariant_liabilityMatchesTrackedActiveBounties() public view {
        uint256 trackedCount = handler.trackedCount();
        uint256 expectedA;
        uint256 expectedB;

        for (uint256 i = 0; i < trackedCount; i++) {
            (uint256 bountyId, address token, uint256 amount,, IBountyEscrow.State state) = handler.trackedBounty(i);
            BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);
            if (
                state == IBountyEscrow.State.Released || state == IBountyEscrow.State.Cancelled
                    || state == IBountyEscrow.State.Refunded || state == IBountyEscrow.State.Settled
            ) {
                assertEq(bounty.amount, 0);
                continue;
            }

            if (state == IBountyEscrow.State.Created) {
                assertEq(bounty.amount, 0);
                continue;
            }

            assertEq(bounty.amount, amount);
            if (token == address(tokenA)) {
                expectedA += bounty.amount;
            } else {
                expectedB += bounty.amount;
            }
        }

        assertEq(escrow.totalLiability(address(tokenA)), expectedA);
        assertEq(escrow.totalLiability(address(tokenB)), expectedB);
        assertLe(escrow.totalLiability(address(tokenA)), tokenA.balanceOf(address(escrow)));
        assertLe(escrow.totalLiability(address(tokenB)), tokenB.balanceOf(address(escrow)));
    }

    function invariant_standardTokenConservationHolds() public view {
        assertEq(
            tokenA.balanceOf(requester) + tokenA.balanceOf(provider) + tokenA.balanceOf(address(escrow)), INITIAL_MINT
        );
        assertEq(
            tokenB.balanceOf(requester) + tokenB.balanceOf(provider) + tokenB.balanceOf(address(escrow)), INITIAL_MINT
        );
    }

    function invariant_commitmentsTrackTheStateMachine() public view {
        uint256 trackedCount = handler.trackedCount();

        for (uint256 i = 0; i < trackedCount; i++) {
            (uint256 bountyId,, uint256 amount,, IBountyEscrow.State state) = handler.trackedBounty(i);
            BountyEscrow.Bounty memory bounty = escrow.getBounty(bountyId);

            assertEq(bounty.scopeHash != bytes32(0), true);
            assertEq(bounty.termsHash != bytes32(0), true);
            assertEq(bounty.provider, provider);
            assertEq(bounty.proposalHash, handler.trackedProposalHash(i));
            assertEq(escrow.bountyIdByRequesterAndTermsHash(requester, handler.trackedTermsHash(i)), bountyId);
            if (bounty.settlementProposer != address(0)) {
                assertTrue(bounty.settlementProposer == requester || bounty.settlementProposer == provider);
                assertLe(bounty.proposedProviderPayout, amount);
                assertGt(bounty.settlementProposalExpiry, 0);
                if (bounty.state == IBountyEscrow.State.Funded || bounty.state == IBountyEscrow.State.ProviderAccepted)
                {
                    assertLe(bounty.settlementProposalExpiry, bounty.deliveryDeadline);
                } else if (bounty.state == IBountyEscrow.State.Delivered) {
                    assertLe(bounty.settlementProposalExpiry, bounty.reviewDeadline);
                }
            } else {
                assertEq(bounty.proposedProviderPayout, 0);
                assertEq(bounty.settlementProposalExpiry, 0);
            }

            if (state == IBountyEscrow.State.Created) {
                assertEq(bounty.amount, 0);
                assertEq(bounty.acceptedTermsHash, bytes32(0));
                assertEq(bounty.evidenceHash, bytes32(0));
                assertEq(bounty.approvalHash, bytes32(0));
            } else if (state == IBountyEscrow.State.Funded) {
                assertEq(bounty.amount, amount);
                assertEq(bounty.acceptedTermsHash, bytes32(0));
                assertEq(bounty.evidenceHash, bytes32(0));
                assertEq(bounty.approvalHash, bytes32(0));
            } else if (state == IBountyEscrow.State.ProviderAccepted) {
                assertEq(bounty.amount, amount);
                assertEq(bounty.acceptedTermsHash, bounty.termsHash);
                assertEq(bounty.evidenceHash, bytes32(0));
                assertEq(bounty.approvalHash, bytes32(0));
            } else if (state == IBountyEscrow.State.Delivered) {
                assertEq(bounty.amount, amount);
                assertEq(bounty.acceptedTermsHash, bounty.termsHash);
                assertEq(bounty.evidenceHash != bytes32(0), true);
                assertEq(bounty.approvalHash, bytes32(0));
                assertGt(bounty.reviewDeadline, 0);
            } else if (state == IBountyEscrow.State.BuyerApproved) {
                assertEq(bounty.amount, amount);
                assertEq(bounty.acceptedTermsHash, bounty.termsHash);
                assertEq(bounty.evidenceHash != bytes32(0), true);
                assertEq(bounty.approvalHash != bytes32(0), true);
                assertGt(bounty.reviewDeadline, 0);
            } else if (
                state == IBountyEscrow.State.Released || state == IBountyEscrow.State.Refunded
                    || state == IBountyEscrow.State.Settled
            ) {
                assertEq(bounty.amount, 0);
                assertEq(bounty.settlementProposer, address(0));
                assertEq(bounty.settlementProposalExpiry, 0);
            } else if (state == IBountyEscrow.State.Cancelled) {
                assertEq(bounty.amount, 0);
                assertEq(bounty.acceptedTermsHash, bytes32(0));
                assertEq(bounty.evidenceHash, bytes32(0));
                assertEq(bounty.approvalHash, bytes32(0));
            }
        }
    }
}
