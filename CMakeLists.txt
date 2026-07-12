cmake_minimum_required(VERSION 3.20)
project(panorama LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

find_package(OpenMP REQUIRED)
find_package(OpenCV REQUIRED COMPONENTS core imgcodecs imgproc)

add_executable(panorama
    src/main.cpp
    src/heightmap.cpp
    src/distmap.cpp
    src/summits.cpp
)

target_link_libraries(panorama PRIVATE
    OpenMP::OpenMP_CXX
    opencv_core
    opencv_imgcodecs
    opencv_imgproc
)
target_include_directories(panorama SYSTEM PRIVATE ${OpenCV_INCLUDE_DIRS})

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(panorama PRIVATE -O3 -march=native -Wall -Wextra)
endif()
