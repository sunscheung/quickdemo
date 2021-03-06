/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */


import {
    FunctionComponent,
    ClassComponent,
    HostRoot,
    HostComponent,
    HostText,
    HostPortal,
    ForwardRef,
    Fragment,
    Mode,
    ContextProvider,
    ContextConsumer,
    Profiler,
    SuspenseComponent,
    MemoComponent,
    SimpleMemoComponent,
    LazyComponent,
    IncompleteClassComponent,
} from 'shared/ReactWorkTags';
import {
    NoEffect,
    PerformedWork,
    Placement,
    ContentReset,
    DidCapture,
    Update,
    Ref,
} from 'shared/ReactSideEffectTags';
import ReactSharedInternals from 'shared/ReactSharedInternals';
import invariant from 'shared/invariant';
import shallowEqual from 'shared/shallowEqual';


import {
    mountChildFibers,
    reconcileChildFibers,
    cloneChildFibers,
} from './ReactChildFiber';
import { processUpdateQueue } from './ReactUpdateQueue';
import { NoWork, Never } from './ReactFiberExpirationTime';
import {
    ConcurrentMode,
    NoContext,
} from './ReactTypeOfMode';
import {
    shouldSetTextContent,
    shouldDeprioritizeSubtree,
} from './ReactFiberHostConfig';
import { pushHostContext, pushHostContainer } from './ReactFiberHostContext';
import {
    pushProvider,
    propagateContextChange,
    readContext,
    prepareToReadContext,
    calculateChangedBits,
} from './ReactFiberNewContext';
import { prepareToUseHooks, finishHooks, resetHooks } from './ReactFiberHooks';
import {
    getMaskedContext,
    getUnmaskedContext,
    hasContextChanged as hasLegacyContextChanged,
    pushContextProvider as pushLegacyContextProvider,
    isContextProvider as isLegacyContextProvider,
    pushTopLevelContextObject,
    invalidateContextProvider,
} from './ReactFiberContext';
import {
    enterHydrationState,
    resetHydrationState,
    tryToClaimNextHydratableInstance,
} from './ReactFiberHydrationContext';
import {
    constructClassInstance,
    mountClassInstance,
    resumeMountClassInstance,
    updateClassInstance,
} from './ReactFiberClassComponent';
import {
    readLazyComponentType,
    resolveDefaultProps,
} from './ReactFiberLazyComponent';
import {
    resolveLazyComponentTag,
    createFiberFromTypeAndProps,
    createFiberFromFragment,
    createWorkInProgress,
    isSimpleFunctionComponent,
} from './ReactFiber';

const ReactCurrentOwner = ReactSharedInternals.ReactCurrentOwner;

export let didWarnAboutReassigningProps;

export function reconcileChildren(
    current,
    workInProgress,
    nextChildren,
    renderExpirationTime,
) {
    if (current === null) {
        // If this is a fresh new component that hasn't been rendered yet, we
        // won't update its child set by applying minimal side-effects. Instead,
        // we will add them all to the child before it gets rendered. That means
        // we can optimize this reconciliation pass by not tracking side-effects.
        workInProgress.child = mountChildFibers(
            workInProgress,
            null,
            nextChildren,
            renderExpirationTime,
        );
    } else {
        // If the current child is the same as the work in progress, it means that
        // we haven't yet started any work on these children. Therefore, we use
        // the clone algorithm to create a copy of all the current children.

        // If we had any progressed work already, that is invalid at this point so
        // let's throw it out.
        workInProgress.child = reconcileChildFibers(
            workInProgress,
            current.child,
            nextChildren,
            renderExpirationTime,
        );
    }
}

function forceUnmountCurrentAndReconcile(
    current,
    workInProgress,
    nextChildren,
    renderExpirationTime,
) {
    // This function is fork of reconcileChildren. It's used in cases where we
    // want to reconcile without matching against the existing set. This has the
    // effect of all current children being unmounted; even if the type and key
    // are the same, the old child is unmounted and a new child is created.
    //
    // To do this, we're going to go through the reconcile algorithm twice. In
    // the first pass, we schedule a deletion for all the current children by
    // passing null.
    workInProgress.child = reconcileChildFibers(
        workInProgress,
        current.child,
        null,
        renderExpirationTime,
    );
    // In the second pass, we mount the new children. The trick here is that we
    // pass null in place of where we usually pass the current child set. This has
    // the effect of remounting all children regardless of whether their their
    // identity matches.
    workInProgress.child = reconcileChildFibers(
        workInProgress,
        null,
        nextChildren,
        renderExpirationTime,
    );
}

function updateForwardRef(
    current,
    workInProgress,
    Component,
    nextProps,
    renderExpirationTime,
) {


    const render = Component.render;
    const ref = workInProgress.ref;

    // The rest is a fork of updateFunctionComponent
    let nextChildren;
    prepareToReadContext(workInProgress, renderExpirationTime);
    prepareToUseHooks(current, workInProgress, renderExpirationTime);

    nextChildren = render(nextProps, ref);

    nextChildren = finishHooks(render, nextProps, nextChildren, ref);

    // React DevTools reads this flag.
    workInProgress.effectTag |= PerformedWork;
    reconcileChildren(
        current,
        workInProgress,
        nextChildren,
        renderExpirationTime,
    );
    return workInProgress.child;
}

function updateMemoComponent(
    current,
    workInProgress,
    Component,
    nextProps,
    updateExpirationTime,
    renderExpirationTime,
) {
    if (current === null) {
        let type = Component.type;
        if (
            isSimpleFunctionComponent(type) &&
            Component.compare === null &&
            // SimpleMemoComponent codepath doesn't resolve outer props either.
            Component.defaultProps === undefined
        ) {
            // If this is a plain function component without default props,
            // and with only the default shallow comparison, we upgrade it
            // to a SimpleMemoComponent to allow fast path updates.
            workInProgress.tag = SimpleMemoComponent;
            workInProgress.type = type;

            return updateSimpleMemoComponent(
                current,
                workInProgress,
                type,
                nextProps,
                updateExpirationTime,
                renderExpirationTime,
            );
        }

        let child = createFiberFromTypeAndProps(
            Component.type,
            null,
            nextProps,
            null,
            workInProgress.mode,
            renderExpirationTime,
        );
        child.ref = workInProgress.ref;
        child.return = workInProgress;
        workInProgress.child = child;
        return child;
    }

    let currentChild = ((current.child)); // This is always exactly one child
    if (updateExpirationTime < renderExpirationTime) {
        // This will be the props with resolved defaultProps,
        // unlike current.memoizedProps which will be the unresolved ones.
        const prevProps = currentChild.memoizedProps;
        // Default to shallow comparison
        let compare = Component.compare;
        compare = compare !== null ? compare : shallowEqual;
        if (compare(prevProps, nextProps) && current.ref === workInProgress.ref) {
            return bailoutOnAlreadyFinishedWork(
                current,
                workInProgress,
                renderExpirationTime,
            );
        }
    }
    // React DevTools reads this flag.
    workInProgress.effectTag |= PerformedWork;
    let newChild = createWorkInProgress(
        currentChild,
        nextProps,
        renderExpirationTime,
    );
    newChild.ref = workInProgress.ref;
    newChild.return = workInProgress;
    workInProgress.child = newChild;
    return newChild;
}

function updateSimpleMemoComponent(
    current,
    workInProgress,
    Component,
    nextProps,
    updateExpirationTime,
    renderExpirationTime,
) {

    if (current !== null && updateExpirationTime < renderExpirationTime) {
        const prevProps = current.memoizedProps;
        if (
            shallowEqual(prevProps, nextProps) &&
            current.ref === workInProgress.ref
        ) {
            return bailoutOnAlreadyFinishedWork(
                current,
                workInProgress,
                renderExpirationTime,
            );
        }
    }
    return updateFunctionComponent(
        current,
        workInProgress,
        Component,
        nextProps,
        renderExpirationTime,
    );
}

function updateFragment(
    current,
    workInProgress,
    renderExpirationTime,
) {
    const nextChildren = workInProgress.pendingProps;
    reconcileChildren(
        current,
        workInProgress,
        nextChildren,
        renderExpirationTime,
    );
    return workInProgress.child;
}

function updateMode(
    current,
    workInProgress,
    renderExpirationTime,
) {
    const nextChildren = workInProgress.pendingProps.children;
    reconcileChildren(
        current,
        workInProgress,
        nextChildren,
        renderExpirationTime,
    );
    return workInProgress.child;
}

function updateProfiler(
    current,
    workInProgress,
    renderExpirationTime,
) {

    const nextProps = workInProgress.pendingProps;
    const nextChildren = nextProps.children;
    reconcileChildren(
        current,
        workInProgress,
        nextChildren,
        renderExpirationTime,
    );
    return workInProgress.child;
}

function markRef(current, workInProgress) {
    const ref = workInProgress.ref;
    if (
        (current === null && ref !== null) ||
        (current !== null && current.ref !== ref)
    ) {
        // Schedule a Ref effect
        workInProgress.effectTag |= Ref;
    }
}

function updateFunctionComponent(
    current,
    workInProgress,
    Component,
    nextProps,
    renderExpirationTime,
) {


    const unmaskedContext = getUnmaskedContext(workInProgress, Component, true);
    const context = getMaskedContext(workInProgress, unmaskedContext);

    let nextChildren;
    prepareToReadContext(workInProgress, renderExpirationTime);
    prepareToUseHooks(current, workInProgress, renderExpirationTime);

    nextChildren = Component(nextProps, context);

    nextChildren = finishHooks(Component, nextProps, nextChildren, context);

    // React DevTools reads this flag.
    workInProgress.effectTag |= PerformedWork;
    reconcileChildren(
        current,
        workInProgress,
        nextChildren,
        renderExpirationTime,
    );
    return workInProgress.child;
}

function updateClassComponent(
    current,
    workInProgress,
    Component,
    nextProps,
    renderExpirationTime,
) {


    // Push context providers early to prevent context stack mismatches.
    // During mounting we don't know the child context yet as the instance doesn't exist.
    // We will invalidate the child context in finishClassComponent() right after rendering.
    let hasContext;
    if (isLegacyContextProvider(Component)) {
        hasContext = true;
        pushLegacyContextProvider(workInProgress);
    } else {
        hasContext = false;
    }
    prepareToReadContext(workInProgress, renderExpirationTime);

    const instance = workInProgress.stateNode;
    let shouldUpdate;
    if (instance === null) {
        if (current !== null) {
            // An class component without an instance only mounts if it suspended
            // inside a non- concurrent tree, in an inconsistent state. We want to
            // tree it like a new mount, even though an empty version of it already
            // committed. Disconnect the alternate pointers.
            current.alternate = null;
            workInProgress.alternate = null;
            // Since this is conceptually a new fiber, schedule a Placement effect
            workInProgress.effectTag |= Placement;
        }
        // In the initial pass we might need to construct the instance.
        constructClassInstance(
            workInProgress,
            Component,
            nextProps,
            renderExpirationTime,
        );
        mountClassInstance(
            workInProgress,
            Component,
            nextProps,
            renderExpirationTime,
        );
        shouldUpdate = true;
    } else if (current === null) {
        // In a resume, we'll already have an instance we can reuse.
        shouldUpdate = resumeMountClassInstance(
            workInProgress,
            Component,
            nextProps,
            renderExpirationTime,
        );
    } else {
        shouldUpdate = updateClassInstance(
            current,
            workInProgress,
            Component,
            nextProps,
            renderExpirationTime,
        );
    }
    const nextUnitOfWork = finishClassComponent(
        current,
        workInProgress,
        Component,
        shouldUpdate,
        hasContext,
        renderExpirationTime,
    );

    return nextUnitOfWork;
}

function finishClassComponent(
    current,
    workInProgress,
    Component,
    shouldUpdate,
    hasContext,
    renderExpirationTime,
) {
    // Refs should update even if shouldComponentUpdate returns false
    markRef(current, workInProgress);

    const didCaptureError = (workInProgress.effectTag & DidCapture) !== NoEffect;

    if (!shouldUpdate && !didCaptureError) {
        // Context providers should defer to sCU for rendering
        if (hasContext) {
            invalidateContextProvider(workInProgress, Component, false);
        }

        return bailoutOnAlreadyFinishedWork(
            current,
            workInProgress,
            renderExpirationTime,
        );
    }

    const instance = workInProgress.stateNode;

    // Rerender
    ReactCurrentOwner.current = workInProgress;
    let nextChildren;
    if (
        didCaptureError &&
        typeof Component.getDerivedStateFromError !== 'function'
    ) {
        // If we captured an error, but getDerivedStateFrom catch is not defined,
        // unmount all the children. componentDidCatch will schedule an update to
        // re-render a fallback. This is temporary until we migrate everyone to
        // the new API.
        // TODO: Warn in a future release.
        nextChildren = null;


    } else {
        nextChildren = instance.render();
    }

    // React DevTools reads this flag.
    workInProgress.effectTag |= PerformedWork;
    if (current !== null && didCaptureError) {
        // If we're recovering from an error, reconcile without reusing any of
        // the existing children. Conceptually, the normal children and the children
        // that are shown on error are two different sets, so we shouldn't reuse
        // normal children even if their identities match.
        forceUnmountCurrentAndReconcile(
            current,
            workInProgress,
            nextChildren,
            renderExpirationTime,
        );
    } else {
        reconcileChildren(
            current,
            workInProgress,
            nextChildren,
            renderExpirationTime,
        );
    }

    // Memoize state using the values we just used to render.
    // TODO: Restructure so we never read values from the instance.
    workInProgress.memoizedState = instance.state;

    // The context might have changed so we need to recalculate it.
    if (hasContext) {
        invalidateContextProvider(workInProgress, Component, true);
    }

    return workInProgress.child;
}

function pushHostRootContext(workInProgress) {
    const root = (workInProgress.stateNode);
    if (root.pendingContext) {
        pushTopLevelContextObject(
            workInProgress,
            root.pendingContext,
            root.pendingContext !== root.context,
        );
    } else if (root.context) {
        // Should always be set
        pushTopLevelContextObject(workInProgress, root.context, false);
    }
    pushHostContainer(workInProgress, root.containerInfo);
}

function updateHostRoot(current, workInProgress, renderExpirationTime) {
    pushHostRootContext(workInProgress);
    const updateQueue = workInProgress.updateQueue;
    invariant(
        updateQueue !== null,
        'If the root does not have an updateQueue, we should have already ' +
        'bailed out. This error is likely caused by a bug in React. Please ' +
        'file an issue.',
    );
    const nextProps = workInProgress.pendingProps;
    const prevState = workInProgress.memoizedState;
    const prevChildren = prevState !== null ? prevState.element : null;
    processUpdateQueue(
        workInProgress,
        updateQueue,
        nextProps,
        null,
        renderExpirationTime,
    );
    const nextState = workInProgress.memoizedState;
    // Caution: React DevTools currently depends on this property
    // being called "element".
    const nextChildren = nextState.element;
    if (nextChildren === prevChildren) {
        // If the state is the same as before, that's a bailout because we had
        // no work that expires at this time.
        resetHydrationState();
        return bailoutOnAlreadyFinishedWork(
            current,
            workInProgress,
            renderExpirationTime,
        );
    }
    const root = workInProgress.stateNode;
    if (
        (current === null || current.child === null) &&
        root.hydrate &&
        enterHydrationState(workInProgress)
    ) {
        // If we don't have any current children this might be the first pass.
        // We always try to hydrate. If this isn't a hydration pass there won't
        // be any children to hydrate which is effectively the same thing as
        // not hydrating.

        // This is a bit of a hack. We track the host root as a placement to
        // know that we're currently in a mounting state. That way isMounted
        // works as expected. We must reset this before committing.
        // TODO: Delete this when we delete isMounted and findDOMNode.
        workInProgress.effectTag |= Placement;

        // Ensure that children mount into this root without tracking
        // side-effects. This ensures that we don't store Placement effects on
        // nodes that will be hydrated.
        workInProgress.child = mountChildFibers(
            workInProgress,
            null,
            nextChildren,
            renderExpirationTime,
        );
    } else {
        // Otherwise reset hydration state in case we aborted and resumed another
        // root.
        reconcileChildren(
            current,
            workInProgress,
            nextChildren,
            renderExpirationTime,
        );
        resetHydrationState();
    }
    return workInProgress.child;
}

function updateHostComponent(current, workInProgress, renderExpirationTime) {
    pushHostContext(workInProgress);

    if (current === null) {
        tryToClaimNextHydratableInstance(workInProgress);
    }

    const type = workInProgress.type;
    const nextProps = workInProgress.pendingProps;
    const prevProps = current !== null ? current.memoizedProps : null;

    let nextChildren = nextProps.children;
    const isDirectTextChild = shouldSetTextContent(type, nextProps);

    if (isDirectTextChild) {
        // We special case a direct text child of a host node. This is a common
        // case. We won't handle it as a reified child. We will instead handle
        // this in the host environment that also have access to this prop. That
        // avoids allocating another HostText fiber and traversing it.
        nextChildren = null;
    } else if (prevProps !== null && shouldSetTextContent(type, prevProps)) {
        // If we're switching from a direct text child to a normal child, or to
        // empty, we need to schedule the text content to be reset.
        workInProgress.effectTag |= ContentReset;
    }

    markRef(current, workInProgress);

    // Check the host config to see if the children are offscreen/hidden.
    if (
        renderExpirationTime !== Never &&
        workInProgress.mode & ConcurrentMode &&
        shouldDeprioritizeSubtree(type, nextProps)
    ) {
        // Schedule this fiber to re-render at offscreen priority. Then bailout.
        workInProgress.expirationTime = Never;
        return null;
    }

    reconcileChildren(
        current,
        workInProgress,
        nextChildren,
        renderExpirationTime,
    );
    return workInProgress.child;
}

function updateHostText(current, workInProgress) {
    if (current === null) {
        tryToClaimNextHydratableInstance(workInProgress);
    }
    // Nothing to do here. This is terminal. We'll do the completion step
    // immediately after.
    return null;
}

function mountLazyComponent(
    _current,
    workInProgress,
    elementType,
    updateExpirationTime,
    renderExpirationTime,
) {
    if (_current !== null) {
        // An lazy component only mounts if it suspended inside a non-
        // concurrent tree, in an inconsistent state. We want to treat it like
        // a new mount, even though an empty version of it already committed.
        // Disconnect the alternate pointers.
        _current.alternate = null;
        workInProgress.alternate = null;
        // Since this is conceptually a new fiber, schedule a Placement effect
        workInProgress.effectTag |= Placement;
    }

    const props = workInProgress.pendingProps;
    // We can't start a User Timing measurement with correct label yet.
    // Cancel and resume right after we know the tag.
    let Component = readLazyComponentType(elementType);
    // Store the unwrapped component in the type.
    workInProgress.type = Component;
    const resolvedTag = (workInProgress.tag = resolveLazyComponentTag(Component));
    const resolvedProps = resolveDefaultProps(Component, props);
    let child;
    switch (resolvedTag) {
        case FunctionComponent: {
            child = updateFunctionComponent(
                null,
                workInProgress,
                Component,
                resolvedProps,
                renderExpirationTime,
            );
            break;
        }
        case ClassComponent: {
            child = updateClassComponent(
                null,
                workInProgress,
                Component,
                resolvedProps,
                renderExpirationTime,
            );
            break;
        }
        case ForwardRef: {
            child = updateForwardRef(
                null,
                workInProgress,
                Component,
                resolvedProps,
                renderExpirationTime,
            );
            break;
        }
        case MemoComponent: {

            child = updateMemoComponent(
                null,
                workInProgress,
                Component,
                resolveDefaultProps(Component.type, resolvedProps), // The inner type can have defaults too
                updateExpirationTime,
                renderExpirationTime,
            );
            break;
        }
        default: {
            let hint = '';

            // This message intentionally doesn't mention ForwardRef or MemoComponent
            // because the fact that it's a separate type of work is an
            // implementation detail.
            invariant(
                false,
                'Element type is invalid. Received a promise that resolves to: %s. ' +
                'Lazy element type must resolve to a class or function.%s',
                Component,
                hint,
            );
        }
    }
    return child;
}

function mountIncompleteClassComponent(
    _current,
    workInProgress,
    Component,
    nextProps,
    renderExpirationTime,
) {
    if (_current !== null) {
        // An incomplete component only mounts if it suspended inside a non-
        // concurrent tree, in an inconsistent state. We want to treat it like
        // a new mount, even though an empty version of it already committed.
        // Disconnect the alternate pointers.
        _current.alternate = null;
        workInProgress.alternate = null;
        // Since this is conceptually a new fiber, schedule a Placement effect
        workInProgress.effectTag |= Placement;
    }

    // Promote the fiber to a class and try rendering again.
    workInProgress.tag = ClassComponent;

    // The rest of this function is a fork of `updateClassComponent`

    // Push context providers early to prevent context stack mismatches.
    // During mounting we don't know the child context yet as the instance doesn't exist.
    // We will invalidate the child context in finishClassComponent() right after rendering.
    let hasContext;
    if (isLegacyContextProvider(Component)) {
        hasContext = true;
        pushLegacyContextProvider(workInProgress);
    } else {
        hasContext = false;
    }
    prepareToReadContext(workInProgress, renderExpirationTime);

    constructClassInstance(
        workInProgress,
        Component,
        nextProps,
        renderExpirationTime,
    );
    mountClassInstance(
        workInProgress,
        Component,
        nextProps,
        renderExpirationTime,
    );

    return finishClassComponent(
        null,
        workInProgress,
        Component,
        true,
        hasContext,
        renderExpirationTime,
    );
}


function updateSuspenseComponent(
    current,
    workInProgress,
    renderExpirationTime,
) {
    const mode = workInProgress.mode;
    const nextProps = workInProgress.pendingProps;

    // We should attempt to render the primary children unless this boundary
    // already suspended during this render (`alreadyCaptured` is true).
    let nextState = workInProgress.memoizedState;

    let nextDidTimeout;
    if ((workInProgress.effectTag & DidCapture) === NoEffect) {
        // This is the first attempt.
        nextState = null;
        nextDidTimeout = false;
    } else {
        // Something in this boundary's subtree already suspended. Switch to
        // rendering the fallback children.
        nextState = {
            timedOutAt: nextState !== null ? nextState.timedOutAt : NoWork,
        };
        nextDidTimeout = true;
        workInProgress.effectTag &= ~DidCapture;
    }

    // This next part is a bit confusing. If the children timeout, we switch to
    // showing the fallback children in place of the "primary" children.
    // However, we don't want to delete the primary children because then their
    // state will be lost (both the React state and the host state, e.g.
    // uncontrolled form inputs). Instead we keep them mounted and hide them.
    // Both the fallback children AND the primary children are rendered at the
    // same time. Once the primary children are un-suspended, we can delete
    // the fallback children — don't need to preserve their state.
    //
    // The two sets of children are siblings in the host environment, but
    // semantically, for purposes of reconciliation, they are two separate sets.
    // So we store them using two fragment fibers.
    //
    // However, we want to avoid allocating extra fibers for every placeholder.
    // They're only necessary when the children time out, because that's the
    // only time when both sets are mounted.
    //
    // So, the extra fragment fibers are only used if the children time out.
    // Otherwise, we render the primary children directly. This requires some
    // custom reconciliation logic to preserve the state of the primary
    // children. It's essentially a very basic form of re-parenting.

    // `child` points to the child fiber. In the normal case, this is the first
    // fiber of the primary children set. In the timed-out case, it's a
    // a fragment fiber containing the primary children.
    let child;
    // `next` points to the next fiber React should render. In the normal case,
    // it's the same as `child`: the first fiber of the primary children set.
    // In the timed-out case, it's a fragment fiber containing the *fallback*
    // children -- we skip over the primary children entirely.
    let next;
    if (current === null) {
        // This is the initial mount. This branch is pretty simple because there's
        // no previous state that needs to be preserved.
        if (nextDidTimeout) {
            // Mount separate fragments for primary and fallback children.
            const nextFallbackChildren = nextProps.fallback;
            const primaryChildFragment = createFiberFromFragment(
                null,
                mode,
                NoWork,
                null,
            );

            if ((workInProgress.mode & ConcurrentMode) === NoContext) {
                // Outside of concurrent mode, we commit the effects from the
                // partially completed, timed-out tree, too.
                const progressedState = workInProgress.memoizedState;
                const progressedPrimaryChild =
                    progressedState !== null
                        ? (workInProgress.child).child
                        : (workInProgress.child);
                primaryChildFragment.child = progressedPrimaryChild;
            }

            const fallbackChildFragment = createFiberFromFragment(
                nextFallbackChildren,
                mode,
                renderExpirationTime,
                null,
            );
            primaryChildFragment.sibling = fallbackChildFragment;
            child = primaryChildFragment;
            // Skip the primary children, and continue working on the
            // fallback children.
            next = fallbackChildFragment;
            child.return = next.return = workInProgress;
        } else {
            // Mount the primary children without an intermediate fragment fiber.
            const nextPrimaryChildren = nextProps.children;
            child = next = mountChildFibers(
                workInProgress,
                null,
                nextPrimaryChildren,
                renderExpirationTime,
            );
        }
    } else {
        // This is an update. This branch is more complicated because we need to
        // ensure the state of the primary children is preserved.
        const prevState = current.memoizedState;
        const prevDidTimeout = prevState !== null;
        if (prevDidTimeout) {
            // The current tree already timed out. That means each child set is
            // wrapped in a fragment fiber.
            const currentPrimaryChildFragment = (current.child);
            const currentFallbackChildFragment = (currentPrimaryChildFragment.sibling);
            if (nextDidTimeout) {
                // Still timed out. Reuse the current primary children by cloning
                // its fragment. We're going to skip over these entirely.
                const nextFallbackChildren = nextProps.fallback;
                const primaryChildFragment = createWorkInProgress(
                    currentPrimaryChildFragment,
                    currentPrimaryChildFragment.pendingProps,
                    NoWork,
                );

                if ((workInProgress.mode & ConcurrentMode) === NoContext) {
                    // Outside of concurrent mode, we commit the effects from the
                    // partially completed, timed-out tree, too.
                    const progressedState = workInProgress.memoizedState;
                    const progressedPrimaryChild =
                        progressedState !== null
                            ? (workInProgress.child).child
                            : (workInProgress.child);
                    if (progressedPrimaryChild !== currentPrimaryChildFragment.child) {
                        primaryChildFragment.child = progressedPrimaryChild;
                    }
                }

                // Clone the fallback child fragment, too. These we'll continue
                // working on.
                const fallbackChildFragment = (primaryChildFragment.sibling = createWorkInProgress(
                    currentFallbackChildFragment,
                    nextFallbackChildren,
                    currentFallbackChildFragment.expirationTime,
                ));
                child = primaryChildFragment;
                primaryChildFragment.childExpirationTime = NoWork;
                // Skip the primary children, and continue working on the
                // fallback children.
                next = fallbackChildFragment;
                child.return = next.return = workInProgress;
            } else {
                // No longer suspended. Switch back to showing the primary children,
                // and remove the intermediate fragment fiber.
                const nextPrimaryChildren = nextProps.children;
                const currentPrimaryChild = currentPrimaryChildFragment.child;
                const primaryChild = reconcileChildFibers(
                    workInProgress,
                    currentPrimaryChild,
                    nextPrimaryChildren,
                    renderExpirationTime,
                );

                // If this render doesn't suspend, we need to delete the fallback
                // children. Wait until the complete phase, after we've confirmed the
                // fallback is no longer needed.
                // TODO: Would it be better to store the fallback fragment on
                // the stateNode?

                // Continue rendering the children, like we normally do.
                child = next = primaryChild;
            }
        } else {
            // The current tree has not already timed out. That means the primary
            // children are not wrapped in a fragment fiber.
            const currentPrimaryChild = current.child;
            if (nextDidTimeout) {
                // Timed out. Wrap the children in a fragment fiber to keep them
                // separate from the fallback children.
                const nextFallbackChildren = nextProps.fallback;
                const primaryChildFragment = createFiberFromFragment(
                    // It shouldn't matter what the pending props are because we aren't
                    // going to render this fragment.
                    null,
                    mode,
                    NoWork,
                    null,
                );
                primaryChildFragment.child = currentPrimaryChild;

                // Even though we're creating a new fiber, there are no new children,
                // because we're reusing an already mounted tree. So we don't need to
                // schedule a placement.
                // primaryChildFragment.effectTag |= Placement;

                if ((workInProgress.mode & ConcurrentMode) === NoContext) {
                    // Outside of concurrent mode, we commit the effects from the
                    // partially completed, timed-out tree, too.
                    const progressedState = workInProgress.memoizedState;
                    const progressedPrimaryChild =
                        progressedState !== null
                            ? (workInProgress.child).child
                            : (workInProgress.child);
                    primaryChildFragment.child = progressedPrimaryChild;
                }



                // Create a fragment from the fallback children, too.
                const fallbackChildFragment = (primaryChildFragment.sibling = createFiberFromFragment(
                    nextFallbackChildren,
                    mode,
                    renderExpirationTime,
                    null,
                ));
                fallbackChildFragment.effectTag |= Placement;
                child = primaryChildFragment;
                primaryChildFragment.childExpirationTime = NoWork;
                // Skip the primary children, and continue working on the
                // fallback children.
                next = fallbackChildFragment;
                child.return = next.return = workInProgress;
            } else {
                // Still haven't timed out.  Continue rendering the children, like we
                // normally do.
                const nextPrimaryChildren = nextProps.children;
                next = child = reconcileChildFibers(
                    workInProgress,
                    currentPrimaryChild,
                    nextPrimaryChildren,
                    renderExpirationTime,
                );
            }
        }
    }

    workInProgress.memoizedState = nextState;
    workInProgress.child = child;
    return next;
}

function updatePortalComponent(
    current,
    workInProgress,
    renderExpirationTime,
) {
    pushHostContainer(workInProgress, workInProgress.stateNode.containerInfo);
    const nextChildren = workInProgress.pendingProps;
    if (current === null) {
        // Portals are special because we don't append the children during mount
        // but at commit. Therefore we need to track insertions which the normal
        // flow doesn't do during mount. This doesn't happen at the root because
        // the root always starts with a "current" with a null child.
        // TODO: Consider unifying this with how the root works.
        workInProgress.child = reconcileChildFibers(
            workInProgress,
            null,
            nextChildren,
            renderExpirationTime,
        );
    } else {
        reconcileChildren(
            current,
            workInProgress,
            nextChildren,
            renderExpirationTime,
        );
    }
    return workInProgress.child;
}

function updateContextProvider(
    current,
    workInProgress,
    renderExpirationTime,
) {
    const providerType = workInProgress.type;
    const context = providerType._context;

    const newProps = workInProgress.pendingProps;
    const oldProps = workInProgress.memoizedProps;

    const newValue = newProps.value;


    pushProvider(workInProgress, newValue);

    if (oldProps !== null) {
        const oldValue = oldProps.value;
        const changedBits = calculateChangedBits(context, newValue, oldValue);
        if (changedBits === 0) {
            // No change. Bailout early if children are the same.
            if (
                oldProps.children === newProps.children &&
                !hasLegacyContextChanged()
            ) {
                return bailoutOnAlreadyFinishedWork(
                    current,
                    workInProgress,
                    renderExpirationTime,
                );
            }
        } else {
            // The context value changed. Search for matching consumers and schedule
            // them to update.
            propagateContextChange(
                workInProgress,
                context,
                changedBits,
                renderExpirationTime,
            );
        }
    }

    const newChildren = newProps.children;
    reconcileChildren(current, workInProgress, newChildren, renderExpirationTime);
    return workInProgress.child;
}


function updateContextConsumer(
    current,
    workInProgress,
    renderExpirationTime,
) {
    let context = workInProgress.type;
    // The logic below for Context differs depending on PROD or DEV mode. In
    // DEV mode, we create a separate object for Context.Consumer that acts
    // like a proxy to Context. This proxy object adds unnecessary code in PROD
    // so we use the old behaviour (Context.Consumer references Context) to
    // reduce size and overhead. The separate object references context via
    // a property called "_context", which also gives us the ability to check
    // in DEV mode if this property exists or not and warn if it does not.

    const newProps = workInProgress.pendingProps;
    const render = newProps.children;

    prepareToReadContext(workInProgress, renderExpirationTime);
    const newValue = readContext(context, newProps.unstable_observedBits);
    let newChildren = render(newValue);


    // React DevTools reads this flag.
    workInProgress.effectTag |= PerformedWork;
    reconcileChildren(current, workInProgress, newChildren, renderExpirationTime);
    return workInProgress.child;
}

function bailoutOnAlreadyFinishedWork(
    current,
    workInProgress,
    renderExpirationTime,
) {

    if (current !== null) {
        // Reuse previous context list
        workInProgress.firstContextDependency = current.firstContextDependency;
    }

    // Check if the children have any pending work.
    const childExpirationTime = workInProgress.childExpirationTime;
    if (childExpirationTime < renderExpirationTime) {
        // The children don't have any work either. We can skip them.
        // TODO: Once we add back resuming, we should check if the children are
        // a work-in-progress set. If so, we need to transfer their effects.
        return null;
    } else {
        // This fiber doesn't have work, but its subtree does. Clone the child
        // fibers and continue.
        cloneChildFibers(current, workInProgress);
        return workInProgress.child;
    }
}

function beginWork(
    current,
    workInProgress,
    renderExpirationTime,
) {
    const updateExpirationTime = workInProgress.expirationTime;

    if (current !== null) {
        const oldProps = current.memoizedProps;
        const newProps = workInProgress.pendingProps;
        if (
            oldProps === newProps &&
            !hasLegacyContextChanged() &&
            updateExpirationTime < renderExpirationTime
        ) {
            // This fiber does not have any pending work. Bailout without entering
            // the begin phase. There's still some bookkeeping we that needs to be done
            // in this optimized path, mostly pushing stuff onto the stack.
            switch (workInProgress.tag) {
                case HostRoot:
                    pushHostRootContext(workInProgress);
                    resetHydrationState();
                    break;
                case HostComponent:
                    pushHostContext(workInProgress);
                    break;
                case ClassComponent: {
                    const Component = workInProgress.type;
                    if (isLegacyContextProvider(Component)) {
                        pushLegacyContextProvider(workInProgress);
                    }
                    break;
                }
                case HostPortal:
                    pushHostContainer(
                        workInProgress,
                        workInProgress.stateNode.containerInfo,
                    );
                    break;
                case ContextProvider: {
                    const newValue = workInProgress.memoizedProps.value;
                    pushProvider(workInProgress, newValue);
                    break;
                }
                case Profiler:

                    break;
                case SuspenseComponent: {
                    const state = workInProgress.memoizedState;
                    const didTimeout = state !== null;
                    if (didTimeout) {
                        // If this boundary is currently timed out, we need to decide
                        // whether to retry the primary children, or to skip over it and
                        // go straight to the fallback. Check the priority of the primary
                        // child fragment.
                        const primaryChildFragment = (workInProgress.child);
                        const primaryChildExpirationTime =
                            primaryChildFragment.childExpirationTime;
                        if (
                            primaryChildExpirationTime !== NoWork &&
                            primaryChildExpirationTime >= renderExpirationTime
                        ) {
                            // The primary children have pending work. Use the normal path
                            // to attempt to render the primary children again.
                            return updateSuspenseComponent(
                                current,
                                workInProgress,
                                renderExpirationTime,
                            );
                        } else {
                            // The primary children do not have pending work with sufficient
                            // priority. Bailout.
                            const child = bailoutOnAlreadyFinishedWork(
                                current,
                                workInProgress,
                                renderExpirationTime,
                            );
                            if (child !== null) {
                                // The fallback children have pending work. Skip over the
                                // primary children and work on the fallback.
                                return child.sibling;
                            } else {
                                return null;
                            }
                        }
                    }
                    break;
                }
            }
            return bailoutOnAlreadyFinishedWork(
                current,
                workInProgress,
                renderExpirationTime,
            );
        }
    }

    // Before entering the begin phase, clear the expiration time.
    workInProgress.expirationTime = NoWork;

    switch (workInProgress.tag) {

        case LazyComponent: {
            const elementType = workInProgress.elementType;
            return mountLazyComponent(
                current,
                workInProgress,
                elementType,
                updateExpirationTime,
                renderExpirationTime,
            );
        }
        case FunctionComponent: {
            const Component = workInProgress.type;
            const unresolvedProps = workInProgress.pendingProps;
            const resolvedProps =
                workInProgress.elementType === Component
                    ? unresolvedProps
                    : resolveDefaultProps(Component, unresolvedProps);
            return updateFunctionComponent(
                current,
                workInProgress,
                Component,
                resolvedProps,
                renderExpirationTime,
            );
        }
        case ClassComponent: {
            const Component = workInProgress.type;
            const unresolvedProps = workInProgress.pendingProps;
            const resolvedProps =
                workInProgress.elementType === Component
                    ? unresolvedProps
                    : resolveDefaultProps(Component, unresolvedProps);
            return updateClassComponent(
                current,
                workInProgress,
                Component,
                resolvedProps,
                renderExpirationTime,
            );
        }
        case HostRoot:
            return updateHostRoot(current, workInProgress, renderExpirationTime);
        case HostComponent:
            return updateHostComponent(current, workInProgress, renderExpirationTime);
        case HostText:
            return updateHostText(current, workInProgress);
        case SuspenseComponent:
            return updateSuspenseComponent(
                current,
                workInProgress,
                renderExpirationTime,
            );
        case HostPortal:
            return updatePortalComponent(
                current,
                workInProgress,
                renderExpirationTime,
            );
        case ForwardRef: {
            const type = workInProgress.type;
            const unresolvedProps = workInProgress.pendingProps;
            const resolvedProps =
                workInProgress.elementType === type
                    ? unresolvedProps
                    : resolveDefaultProps(type, unresolvedProps);
            return updateForwardRef(
                current,
                workInProgress,
                type,
                resolvedProps,
                renderExpirationTime,
            );
        }
        case Fragment:
            return updateFragment(current, workInProgress, renderExpirationTime);
        case Mode:
            return updateMode(current, workInProgress, renderExpirationTime);
        case Profiler:
            return updateProfiler(current, workInProgress, renderExpirationTime);
        case ContextProvider:
            return updateContextProvider(
                current,
                workInProgress,
                renderExpirationTime,
            );
        case ContextConsumer:
            return updateContextConsumer(
                current,
                workInProgress,
                renderExpirationTime,
            );
        case MemoComponent: {
            const type = workInProgress.type;
            const unresolvedProps = workInProgress.pendingProps;
            // Resolve outer props first, then resolve inner props.
            let resolvedProps = resolveDefaultProps(type, unresolvedProps);

            resolvedProps = resolveDefaultProps(type.type, resolvedProps);
            return updateMemoComponent(
                current,
                workInProgress,
                type,
                resolvedProps,
                updateExpirationTime,
                renderExpirationTime,
            );
        }
        case SimpleMemoComponent: {
            return updateSimpleMemoComponent(
                current,
                workInProgress,
                workInProgress.type,
                workInProgress.pendingProps,
                updateExpirationTime,
                renderExpirationTime,
            );
        }
        case IncompleteClassComponent: {
            const Component = workInProgress.type;
            const unresolvedProps = workInProgress.pendingProps;
            const resolvedProps =
                workInProgress.elementType === Component
                    ? unresolvedProps
                    : resolveDefaultProps(Component, unresolvedProps);
            return mountIncompleteClassComponent(
                current,
                workInProgress,
                Component,
                resolvedProps,
                renderExpirationTime,
            );
        }
        default:
            invariant(
                false,
                'Unknown unit of work tag. This error is likely caused by a bug in ' +
                'React. Please file an issue.',
            );
    }
}

export { beginWork };