#pragma once
// parallelFor — minimal dynamically-scheduled parallel index loop on
// std::thread.
//
// Workers (including the calling thread) pull grain-sized index chunks off a
// shared atomic counter, which is dynamic scheduling: uneven chunk costs
// balance automatically (ray columns finish early on sky, isolation searches
// vary by orders of magnitude). Consequently chunk execution order is
// unspecified — callers must ensure every index owns its output slice.
//
// Exceptions: the first one thrown by any chunk is rethrown on the calling
// thread after all workers drained (remaining workers stop at their next
// chunk boundary; later exceptions are dropped).
//
// Serial fallback: Emscripten without pthreads (our WASM build), a single
// CPU, or a range that fits one chunk.

#include <algorithm>
#include <atomic>
#include <exception>
#include <thread>
#include <vector>

namespace pano {

template <typename F> // F: void(int chunkBegin, int chunkEnd)
void parallelFor(int begin, int end, int grain, F &&f)
{
    if (end <= begin)
        return;
#if defined(__EMSCRIPTEN__) && !defined(__EMSCRIPTEN_PTHREADS__)
    static_cast<void>(grain);
    f(begin, end);
#else
    grain = std::max(grain, 1);
    const int chunks = (end - begin + grain - 1) / grain;
    const int hardware = int(std::thread::hardware_concurrency());
    const int nThreads = std::clamp(chunks, 1, std::max(hardware, 1));
    if (nThreads == 1) {
        f(begin, end);
        return;
    }

    std::atomic<int> next{begin};
    std::atomic<bool> failed{false};
    std::exception_ptr firstError; // written by the failed.exchange winner
                                   // only; joins order it before the rethrow
    const auto worker = [&]() noexcept {
        while (!failed.load(std::memory_order_relaxed)) {
            const int b = next.fetch_add(grain, std::memory_order_relaxed);
            if (b >= end)
                break;
            try {
                f(b, std::min(b + grain, end));
            } catch (...) {
                if (!failed.exchange(true))
                    firstError = std::current_exception();
                break;
            }
        }
    };

    std::vector<std::jthread> threads; // jthread: joins even if unwinding
    threads.reserve(size_t(nThreads) - 1);
    for (int i = 0; i < nThreads - 1; ++i)
        threads.emplace_back(worker);
    worker();
    for (std::jthread &t : threads)
        t.join();
    if (firstError)
        std::rethrow_exception(firstError);
#endif
}

// Without a grain opinion: a few chunks per thread, enough for balancing.
template <typename F>
void parallelFor(int begin, int end, F &&f)
{
    const int hardware = std::max(1, int(std::thread::hardware_concurrency()));
    parallelFor(begin, end, std::max(1, (end - begin) / (hardware * 4)),
                std::forward<F>(f));
}

} // namespace pano
