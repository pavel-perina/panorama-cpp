cmake_minimum_required(VERSION 3.20)
project(panorama LANGUAGES C CXX) # C: vendored zstd decoder

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

option(PANO_EXACT_RAYCAST
    "Exact per-sample geographic transform in the ray loop (slow; A/B verification)" OFF)
if(PANO_EXACT_RAYCAST)
    add_compile_definitions(PANO_EXACT_RAYCAST)
endif()

if(EMSCRIPTEN)
    # WASM library for the web app: compute only, no OpenCV/OpenMP.
    # Build:  source ~/emsdk/emsdk_env.sh && emcmake cmake -B build-wasm -S . && cmake --build build-wasm
    # Output: build-wasm/pano.js + pano.wasm (copy or serve next to web/).
    add_executable(pano_wasm
        src/wasm_api.cpp
        src/heightmap.cpp
        src/distmap.cpp
        src/summits.cpp
        src/common/colors.cpp
        src/3rd_party/zstd/zstddeclib.c
    )
    set_target_properties(pano_wasm PROPERTIES OUTPUT_NAME pano)
    target_include_directories(pano_wasm PRIVATE src)
    target_include_directories(pano_wasm SYSTEM PRIVATE src/3rd_party/zstd)
    target_compile_options(pano_wasm PRIVATE
        -O3 -msimd128 -Wall -Wextra -Wno-unknown-pragmas)
    target_link_options(pano_wasm PRIVATE
        -O3
        -sMODULARIZE=1
        -sEXPORT_NAME=createPanoModule
        -sENVIRONMENT=web,node
        -sALLOW_MEMORY_GROWTH=1
        -sSTACK_SIZE=1MB
        -sEXPORTED_FUNCTIONS=_pano_reset,_pano_addTile,_pano_addTileZst,_pano_render,_pano_tonemap,_pano_width,_pano_height,_pano_summits,_malloc,_free
        -sEXPORTED_RUNTIME_METHODS=cwrap,HEAPU8,HEAPU16,UTF8ToString
    )
else()
    find_package(OpenMP REQUIRED)
    find_package(OpenCV REQUIRED COMPONENTS core imgcodecs imgproc)

    add_executable(panorama
        src/main.cpp
        src/heightmap.cpp
        src/distmap.cpp
        src/summits.cpp
        src/annotate.cpp
        src/common/colors.cpp
        src/3rd_party/zstd/zstddeclib.c
    )
    target_include_directories(panorama PRIVATE src)
    target_include_directories(panorama SYSTEM PRIVATE src/3rd_party/zstd)

    target_link_libraries(panorama PRIVATE
        OpenMP::OpenMP_CXX
        opencv_core
        opencv_imgcodecs
        opencv_imgproc
    )
    target_include_directories(panorama SYSTEM PRIVATE ${OpenCV_INCLUDE_DIRS})

    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        # -ffp-contract=off: no FMA fusion, keeps the distance map
        # bit-identical to the WASM build (verified by web/test-node.mjs)
        target_compile_options(panorama PRIVATE
            -O3 -march=native -ffp-contract=off -Wall -Wextra)
    endif()
endif()
